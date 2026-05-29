import os

from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

load_dotenv()

connection_string = os.getenv("AZURE_AI_PROJECT_CONNECTION_STRING")

if not connection_string:
    raise ValueError("Missing AZURE_AI_PROJECT_CONNECTION_STRING in .env")

project = AIProjectClient(
    endpoint=connection_string,
    credential=DefaultAzureCredential(),
)

print("Connected to Microsoft Foundry project.")
print("Project client created successfully.")
