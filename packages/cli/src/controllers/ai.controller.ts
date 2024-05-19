import { Post, RestController } from '@/decorators';
import { AIRequest } from '@/requests';
import { AIService } from '@/services/ai.service';
import { NodeTypes } from '@/NodeTypes';
import express from 'express';
import {
	ChatPromptTemplate,
	SystemMessagePromptTemplate,
} from '@langchain/core/prompts';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { DynamicTool } from '@langchain/core/tools';
import { AgentExecutor, createReactAgent } from 'langchain/agents';
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from '@pinecone-database/pinecone';
import { DuckDuckGoSearch, SearchTimeType } from "@langchain/community/tools/duckduckgo_search";
import { Calculator } from 'langchain/tools/calculator';
import { DEBUG_CONVERSATION_RULES, FREE_CHAT_CONVERSATION_RULES, REACT_CHAT_PROMPT } from '@/aiAssistant/prompts';
import { FailedDependencyError } from '@/errors/response-errors/failed-dependency.error';

// ReAct agent history is string, according to the docs:
// https://js.langchain.com/v0.1/docs/modules/agents/agent_types/react/#using-with-chat-history
// TODO:
//	- 	Add sessions support
//	- 	We can use UserMessage and SystemMessage classes to make it more readable
//		but in the end it has to render to a string
let chatHistory: string[] = [];
const stringifyHistory = (history: string[]) => history.join('\n');

// Tool history is just for debugging
let toolHistory = {
	calculator: [] as string[],
	internet_search: [] as string[],
	get_n8n_info: [] as string[],
};

const INTERNET_TOOL_SITES = ['https://community.n8n.io', 'https://blog.n8n.io', 'https://n8n.io'];

const resetToolHistory = () => {
	toolHistory = {
		calculator: [],
		internet_search: [],
		get_n8n_info: [],
	};
}

const getHumanMessages = (history: string[]) => {
	return history.filter((message, index) => message.startsWith('Human:'));
}

// Remove id and position from node parameters since they are not relevant to the assistant
const removeUnrelevantNodeProps = (parameters: any) => {
	const newParameters = { ...parameters };
	delete newParameters.id;
	delete newParameters.position;
	return newParameters;
}

const assistantModel = new ChatOpenAI({
	temperature: 0,
	openAIApiKey: process.env.N8N_AI_OPENAI_API_KEY,
	modelName: 'gpt-4o',
	streaming: true,
});

@RestController('/ai')
export class AIController {
	constructor(
		private readonly aiService: AIService,
		private readonly nodeTypes: NodeTypes,
	) {}

	/**
 	* Chat with AI assistant that has access to few different tools.
 	* THIS IS THE FREE-CHAT MODE
 	*/
	@Post('/chat-with-assistant', { skipAuth: true })
	async chatWithAssistant(req: AIRequest.AskAssistant, res: express.Response) {
		const { message, newSession } = req.body;
		if (newSession) {
			chatHistory = [];
		}
		resetToolHistory();
		await this.askAssistant(message, res);
	}

	/**
	 * Debug n8n error using the agent that has access to different tools.
	 * THIS IS THE DEBUG MODE
	 */
	@Post('/debug-with-assistant', { skipAuth: true })
	async debugWithAssistant(req: AIRequest.AssistantDebug, res: express.Response) {
		const { nodeType, error, authType, message, userTraits } = req.body;
		resetToolHistory();
		if (message) {
			await this.askAssistant(`${message }\n`, res, true);
			return;
		}
		chatHistory = []
		let authPrompt = `I am using the following authentication type: ${authType?.name}`
		if (!authType) {
			authPrompt = `This is the JSON object that represents n8n credentials for the this node: ${JSON.stringify(error.node.credentials)}`
		}
		const userPrompt = `
			I am having the following error in my ${nodeType.displayName} node: ${error.message} ${ error.description ? `- ${error.description}` : ''}
			- Here is some more information about my workflow and myself that you can use to provide a solution:
				- ${authPrompt}. Use this info to only provide solutions that are compatible with the related to this authentication type and not the others.
				- This is the JSON object that represents the node that I am having an error in, you can use it to inspect current node parameter values: ${JSON.stringify(removeUnrelevantNodeProps(error.node))}
				- n8n version and deployment type that I am using: ${userTraits.n8nVersion},
				- Version of the ${nodeType.displayName} node that I am having an error in: ${userTraits.nodeVersion}
			`;

		await this.askAssistant(userPrompt, res, true);
	}

	/**
	 * Chat with pinecone vector store that contains n8n documentation.
	 * This endpoint is not used in the assistant currently but can be used to test
	 * access to n8n docs without the agent if needed (cheaper & faster, but less accurate, option).
	 */
	@Post('/ask-pinecone')
	async askPinecone(req: AIRequest.DebugChat, res: express.Response) {
		const question = 'How to submit new workflows to n8n templates library?';
		console.log("\n>> 🤷 <<", question);
		const documentation = await this.searchDocsVectorStore(question);
		// ----------------- Prompt -----------------
		const systemMessage = SystemMessagePromptTemplate.fromTemplate(`
			You are an automation expert and are tasked to help users answer their questions about n8n.
			Use the following pieces of context to answer the question at the end.
			If you don't know the answer, just say that you don't know, don't try to make up an answer.
			Try to make the answers actionable and easy to follow for users that are just starting with n8n.

			{docs}

			Question: {question}
			Helpful Answer:
		`);
		const systemMessageFormatted = await systemMessage.format({ docs: documentation, question });
		const prompt = ChatPromptTemplate.fromMessages([
			systemMessageFormatted,
			['human', '{question}'],
		]);
		// ----------------- Chain -----------------
		const chain = prompt.pipe(assistantModel);
		const response = await chain.invoke({ question });
		console.log(">> 🧰 << Final answer:\n", response.content);
		return response.content;
	}

	/**
 	* Generate CURL request and additional HTTP Node metadata for given service and request
 	*/
	@Post('/generate-curl')
	async generateCurl(req: AIRequest.GenerateCurl): Promise<{ curl: string; metadata?: object }> {
		const { service, request } = req.body;

		try {
			return await this.aiService.generateCurl(service, request);
		} catch (aiServiceError) {
			throw new FailedDependencyError(
				(aiServiceError as Error).message ||
					'Failed to generate HTTP Request Node parameters due to an issue with an external dependency. Please try again later.',
			);
		}
	}

	// ---------------------------------------------------------- UTIL FUNCTIONS ----------------------------------------------------------
	async searchDocsVectorStore(question: string) {
		// ----------------- Vector store -----------------
		const pc = new Pinecone({
			apiKey: process.env.N8N_AI_PINECONE_API_KEY ?? ''
		});
		const index = pc.Index('n8n-docs');
		const vectorStore = await PineconeStore.fromExistingIndex(new OpenAIEmbeddings({
			openAIApiKey: process.env.N8N_AI_OPENAI_API_KEY,
			modelName: 'text-embedding-3-large',
			dimensions: 3072
		}), {
			pineconeIndex: index,
		})
		// ----------------- Get top chunks matching query -----------------
		const results = await vectorStore.similaritySearch(question, 3);
		console.log(">> 🧰 << GOT THESE DOCUMENTS:");
		let out = ""
		// This will make sure that we don't repeat the same document in the output
		const documents: string[] = [];
		results.forEach((result, i) => {
			if (documents.includes(result.metadata.source)) {
				return;
			}
			documents.push(result.metadata.source);
			console.log("\t📃", result.metadata.source);
			toolHistory.get_n8n_info.push(result.metadata.source);
			out += `--- N8N DOCUMENTATION DOCUMENT ${i+1} ---\n${result.pageContent}\n\n`
		})
		if (results.length === 0) {
			toolHistory.get_n8n_info.push("NO DOCS FOUND");
		}
		return out;
	}

	async askAssistant(message: string, res: express.Response, debug?: boolean) {
		// ----------------- Tools -----------------
		const calculatorTool = new DynamicTool({
			name: "calculator",
			description: "Performs arithmetic operations. Use this tool whenever you need to perform calculations.",
			func: async (input: string) => {
				console.log(">> 🧰 << calculatorTool:", input);
				const calculator = new Calculator();
				return await calculator.invoke(input);
			}
		});


		const n8nInfoTool = new DynamicTool({
			name: "get_n8n_info",
			description: "Has access to the most relevant pages from the official n8n documentation.",
			func: async (input: string) => {
				console.log(">> 🧰 << n8nInfoTool:", input);
				return (await this.searchDocsVectorStore(input)).toString();
			}
		});

		const internetSearchTool = new DynamicTool({
			name: "internet_search",
			description: "Searches the n8n internet sources for the answer to a question.",
			func: async (input: string) => {
				const searchQuery = `${input} site:${INTERNET_TOOL_SITES.join(' OR site:')}`
				console.log(">> 🧰 << internetSearchTool:", searchQuery);
				const duckDuckGoSearchTool = new DuckDuckGoSearch({ maxResults: 10 });
				const response = await duckDuckGoSearchTool.invoke(searchQuery);
				try {
					const objectResponse: { link?: string }[] = JSON.parse(response);
					objectResponse.forEach((result) => {
						if (result.link) {
							toolHistory.internet_search.push(result.link);
						}
					});
					if (toolHistory.internet_search.length === 0) {
						toolHistory.internet_search.push("NO FORUM PAGES FOUND");
					}
				} catch (error) {
					console.error("Error parsing search results", error);
				}
				console.log(">> 🧰 << duckDuckGoSearchTool:", response);
				return response;
			}
		});

		const tools = [
			calculatorTool,
			n8nInfoTool,
			internetSearchTool,
		];

		const toolNames = tools.map((tool) => tool.name);
		// ----------------- Agent -----------------
		const chatPrompt = ChatPromptTemplate.fromTemplate(REACT_CHAT_PROMPT);
		// Different conversation rules for debug and free-chat modes
		const conversationRules = debug ? DEBUG_CONVERSATION_RULES : FREE_CHAT_CONVERSATION_RULES;
		const humanAskedForSuggestions = getHumanMessages(chatHistory).filter((message) => {
			return message.includes('I need another suggestion') || message.includes('I need more detailed instructions');
		});

		// Hard-stop if human asks for too many suggestions
		if (humanAskedForSuggestions.length >= 3) {
			if (debug) {
				message = 'I have asked for too many new suggestions. Please follow your conversation rules for this case.'
			}
		} else {
			message += ' Please only give me information from the official n8n sources.';
		}

		const agent = await createReactAgent({
			llm: assistantModel,
			tools,
			prompt: chatPrompt,
		});

		const agentExecutor = new AgentExecutor({
			agent,
			tools,
			returnIntermediateSteps: true,
		});

		console.log("\n>> 🤷 <<", message.trim());
		let response =  '';
		try {
			// TODO: Add streaming & LangSmith tracking
			const result = await agentExecutor.invoke({
				input: message,
				chat_history: stringifyHistory(chatHistory),
				conversation_rules: conversationRules,
				tool_names: toolNames,
			});
			response = result.output;
			// console.log();
			// console.log('--------------------- 📋 INTERMEDIATE STEPS ------------------------------------');
			// result.intermediateSteps.forEach((step) => {
			// 	console.log('🦾', step.action.toString());
			// 	console.log('🧠', step.observation);
			// });
			// console.log('-----------------------------------------------------------------------------');
			// console.log();
		} catch (error) {
			// TODO: This can be handled by agentExecutor
			response = error.toString().replace(/Error: Could not parse LLM output: /, '');
		}
		console.log(">> 🤖 <<", response);

		chatHistory.push(`Human: ${message}`);
		chatHistory.push(`Assistant: ${response}`);
		res.write(response + '\n \n');
		res.write(`
\`\`\`
-------------- DEBUG INFO --------------
${toolHistory.get_n8n_info.length > 0 ? `N8N DOCS DOCUMENTS USED: ${toolHistory.get_n8n_info.join(', ')}` : ''}
${toolHistory.internet_search.length > 0 ? `FORUM PAGES USED: ${toolHistory.internet_search.join(',')}` : ''}
${toolHistory.get_n8n_info.length === 0 && toolHistory.internet_search.length === 0 ? '\nNO TOOLS USED' : ''}
\`\`\`
	`);
		res.write('\n');
		res.write('');
		res.end('__END__');
	}

}
