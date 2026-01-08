"""
Import/update n8n workflows from JSON files.

Usage:
    1. Ensure N8N_API_KEY is set in n8n/.env
    2. Place workflow JSON files in n8n/workflows/
    3. Run: python import_workflows.py [options]

Options:
    --activate       Activate all workflows after import (default)
    --no-activate    Don't activate workflows after import
    --dry-run        Show what would be done without making changes
"""

import httpx
import json
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Fix Unicode output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Load .env from n8n folder (same directory as this script)
env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)


def get_n8n_base_url() -> str:
    """Extract n8n base URL from environment variables."""
    if base_url := os.getenv("N8N_BASE_URL"):
        return base_url.rstrip("/")
    return "http://localhost:5678"


# Configuration
N8N_BASE_URL = get_n8n_base_url()
N8N_API_KEY = os.getenv("N8N_API_KEY", "")

# Input directory (relative to this script)
WORKFLOWS_DIR = Path(__file__).parent / "workflows"


def get_existing_workflow(headers: dict, workflow_id: str) -> dict | None:
    """Check if a workflow exists by ID."""
    try:
        response = httpx.get(
            f"{N8N_BASE_URL}/api/v1/workflows/{workflow_id}",
            headers=headers,
            timeout=30
        )
        if response.status_code == 200:
            return response.json()
        return None
    except Exception:
        return None


def clean_nodes(nodes: list) -> list:
    """
    Clean nodes to remove any fields that the API doesn't accept.
    """
    allowed_node_fields = {
        "parameters", "type", "typeVersion", "position", "id", "name",
        "credentials", "disabled", "notes", "notesInFlow", "webhookId",
        "alwaysOutputData", "executeOnce", "onError", "continueOnFail",
        "retryOnFail", "maxTries", "waitBetweenTries"
    }
    
    cleaned = []
    for node in nodes:
        cleaned_node = {k: v for k, v in node.items() if k in allowed_node_fields}
        cleaned.append(cleaned_node)
    
    return cleaned


def prepare_workflow_payload(workflow_data: dict) -> dict:
    """
    Prepare workflow data for API submission.
    Only includes fields that the n8n API accepts.
    """
    # Only these fields are accepted by the n8n API for create/update
    payload = {
        "name": workflow_data.get("name", "Unnamed Workflow"),
        "nodes": clean_nodes(workflow_data.get("nodes", [])),
        "connections": workflow_data.get("connections", {}),
        "settings": workflow_data.get("settings", {"executionOrder": "v1"}),
    }
    
    return payload


def create_workflow(headers: dict, workflow_data: dict, dry_run: bool = False) -> tuple[bool, str, str | None]:
    """
    Create a new workflow.
    
    Returns:
        (success, message, new_workflow_id or None)
    """
    payload = prepare_workflow_payload(workflow_data)
    
    if dry_run:
        return True, f"Would create: {workflow_data.get('name')}", None
    
    try:
        response = httpx.post(
            f"{N8N_BASE_URL}/api/v1/workflows",
            headers=headers,
            json=payload,
            timeout=30
        )
        response.raise_for_status()
        result = response.json()
        new_id = result.get("id")
        return True, "created", new_id
    except httpx.HTTPStatusError as e:
        return False, f"HTTP {e.response.status_code}: {e.response.text[:200]}", None
    except Exception as e:
        return False, str(e), None


def update_workflow(headers: dict, workflow_id: str, workflow_data: dict, dry_run: bool = False) -> tuple[bool, str]:
    """Update an existing workflow."""
    payload = prepare_workflow_payload(workflow_data)
    
    if dry_run:
        return True, f"Would update: {workflow_data.get('name')}"
    
    try:
        response = httpx.put(
            f"{N8N_BASE_URL}/api/v1/workflows/{workflow_id}",
            headers=headers,
            json=payload,
            timeout=30
        )
        response.raise_for_status()
        return True, "updated"
    except httpx.HTTPStatusError as e:
        return False, f"HTTP {e.response.status_code}: {e.response.text[:200]}"
    except Exception as e:
        return False, str(e)


def activate_workflow(headers: dict, workflow_id: str, dry_run: bool = False) -> tuple[bool, str]:
    """Activate a workflow."""
    if dry_run:
        return True, "Would activate"
    
    try:
        response = httpx.post(
            f"{N8N_BASE_URL}/api/v1/workflows/{workflow_id}/activate",
            headers=headers,
            timeout=30
        )
        response.raise_for_status()
        return True, "activated"
    except httpx.HTTPStatusError as e:
        # 400 might mean already active
        if e.response.status_code == 400:
            return True, "already active"
        return False, f"HTTP {e.response.status_code}"
    except Exception as e:
        return False, str(e)


def import_all_workflows(activate: bool = True, dry_run: bool = False):
    """Import all workflows from the workflows directory."""
    
    if not N8N_API_KEY:
        print("❌ Error: N8N_API_KEY is required!")
        print(f"   Add it to: {env_path}")
        print("   Example: N8N_API_KEY=n8n_api_xxxxxxxxxxxxxxxx")
        return
    
    if not WORKFLOWS_DIR.exists():
        print(f"❌ Error: Workflows directory not found: {WORKFLOWS_DIR}")
        return
    
    workflow_files = list(WORKFLOWS_DIR.glob("*.json"))
    if not workflow_files:
        print(f"❌ No workflow JSON files found in: {WORKFLOWS_DIR}")
        return
    
    headers = {
        "X-N8N-API-KEY": N8N_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    
    if dry_run:
        print("🔍 DRY RUN - No changes will be made\n")
    
    print(f"Connecting to n8n at: {N8N_BASE_URL}")
    print(f"Found {len(workflow_files)} workflow files\n")
    
    results = {
        "created": [],
        "updated": [],
        "activated": [],
        "failed": []
    }
    
    for wf_file in workflow_files:
        try:
            with open(wf_file, "r", encoding="utf-8") as f:
                workflow_data = json.load(f)
            
            wf_id = workflow_data.get("id")
            wf_name = workflow_data.get("name", wf_file.stem)
            
            # Track the ID to use for activation
            activate_id = wf_id
            existing = None
            
            # Check if workflow exists (only if we have an ID)
            if wf_id:
                existing = get_existing_workflow(headers, wf_id)
            
            if existing:
                # Update existing workflow
                success, msg = update_workflow(headers, wf_id, workflow_data, dry_run)
                if success:
                    print(f"✓ Updated: {wf_name}")
                    results["updated"].append(wf_name)
                else:
                    print(f"✗ Failed to update '{wf_name}': {msg}")
                    results["failed"].append((wf_name, msg))
                    continue
            else:
                # Create new workflow - n8n assigns a new ID
                success, msg, new_id = create_workflow(headers, workflow_data, dry_run)
                if success:
                    print(f"✓ Created: {wf_name}" + (f" (ID: {new_id})" if new_id else ""))
                    results["created"].append(wf_name)
                    # Use the new ID assigned by n8n for activation
                    if new_id:
                        activate_id = new_id
                        # Update the local file with the new ID
                        if not dry_run:
                            workflow_data["id"] = new_id
                            # Update filename to include new ID
                            new_filename = f"{wf_name}_{new_id}.json"
                            new_filepath = wf_file.parent / new_filename
                            with open(new_filepath, "w", encoding="utf-8") as f:
                                json.dump(workflow_data, f, indent=2, ensure_ascii=False)
                            # Remove old file if different
                            if wf_file != new_filepath and wf_file.exists():
                                wf_file.unlink()
                            print(f"  → Saved with ID: {new_filepath.name}")
                else:
                    print(f"✗ Failed to create '{wf_name}': {msg}")
                    results["failed"].append((wf_name, msg))
                    continue
            
            # Activate if requested
            if activate and activate_id:
                success, msg = activate_workflow(headers, activate_id, dry_run)
                if success:
                    results["activated"].append(wf_name)
                else:
                    print(f"  ⚠ Failed to activate: {msg}")
        
        except json.JSONDecodeError as e:
            print(f"✗ Invalid JSON in {wf_file.name}: {e}")
            results["failed"].append((wf_file.name, "Invalid JSON"))
        except Exception as e:
            print(f"✗ Error processing {wf_file.name}: {e}")
            results["failed"].append((wf_file.name, str(e)))
    
    # Summary
    print(f"\n{'='*50}")
    print("Summary:")
    print(f"  Created:   {len(results['created'])}")
    print(f"  Updated:   {len(results['updated'])}")
    if activate:
        print(f"  Activated: {len(results['activated'])}")
    print(f"  Failed:    {len(results['failed'])}")
    
    if results["failed"]:
        print("\nFailed workflows:")
        for name, reason in results["failed"]:
            print(f"  - {name}: {reason}")
    
    if dry_run:
        print("\n🔍 This was a dry run. No changes were made.")


if __name__ == "__main__":
    activate = "--no-activate" not in sys.argv
    dry_run = "--dry-run" in sys.argv
    
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        sys.exit(0)
    
    import_all_workflows(activate=activate, dry_run=dry_run)

