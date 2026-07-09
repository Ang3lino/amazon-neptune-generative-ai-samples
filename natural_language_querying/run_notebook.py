"""Run the NLQ notebook flow end-to-end without Jupyter. Usage: python run_notebook.py"""
import boto3
from langchain_community.graphs import NeptuneAnalyticsGraph
from langchain_aws import ChatBedrock
from langchain_core.prompts import PromptTemplate

GRAPH_ID = "g-46jp136r81"
REGION = "us-east-1"
MODEL_ID = "us.anthropic.claude-sonnet-4-6"

import os
os.environ.setdefault("AWS_DEFAULT_REGION", REGION)

print(f"Connecting to {GRAPH_ID}...")
graph = NeptuneAnalyticsGraph(graph_identifier=GRAPH_ID)
print(f"Schema:\n{graph.schema}\n")

llm = ChatBedrock(model_id=MODEL_ID, client=boto3.client('bedrock-runtime', region_name=REGION))

CYPHER_PROMPT = PromptTemplate.from_template(
    "Given the following graph schema:\n{schema}\n\n"
    "Write an openCypher query to answer: {question}\n"
    "Return only the query, no explanation."
)

ANSWER_PROMPT = PromptTemplate.from_template(
    "Given this question: {question}\n"
    "And these query results: {results}\n"
    "Provide a natural language answer."
)

def ask(question: str) -> str:
    cypher = llm.invoke(CYPHER_PROMPT.format(schema=graph.schema, question=question)).content.strip()
    cypher = cypher.replace("```cypher", "").replace("```", "").strip()
    print(f"  Generated Cypher: {cypher}")
    results = graph.query(cypher)
    print(f"  Results: {results[:3]}{'...' if len(results) > 3 else ''}")
    answer = llm.invoke(ANSWER_PROMPT.format(question=question, results=results)).content
    return answer

questions = [
    "How many airports are there?",
    "Where can I fly from Anchorage with no stops?",
]

for q in questions:
    print(f"\n{'='*60}\nQ: {q}")
    print(f"A: {ask(q)}")
