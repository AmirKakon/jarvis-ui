# update-workflow-summary

Update the workflow summary markdown file with the latest workflows from the n8n folder.

## Instructions

1. Read all JSON workflow files from `./n8n/workflows/`
2. For each workflow, extract:
   - Name, ID, status (active/archived)
   - Trigger type (webhook, form, execute workflow trigger)
   - Purpose/description
   - Connected tools and sub-workflows
   - Key nodes and their functions
   - Input/output schemas (where applicable)
3. Update `./n8n/workflows-summary.md` with the extracted information
4. Preserve the existing document structure (table of contents, architecture diagram, credentials section)
5. Update the "Last updated" date at the top of the file