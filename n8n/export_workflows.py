"""
Export all n8n workflows to JSON files.

Usage:
    1. Generate an API key in n8n: Settings → API → Create API Key
    2. Add N8N_API_KEY to your backend/.env file
    3. Run: python export_workflows.py [options]

Options:
    --include-archived    Also export archived/inactive workflows
    --organize-by-folder  Organize exports into folders matching n8n projects/tags
    --flat                Export all to single directory (default)
"""

import httpx
import json
import os
import sys
from pathlib import Path
from datetime import datetime
from urllib.parse import urlparse
from dotenv import load_dotenv

# Fix Unicode output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Load .env from n8n folder (same directory as this script)
env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)


def get_n8n_base_url() -> str:
    """Extract n8n base URL from environment variables."""
    # First check for explicit base URL
    if base_url := os.getenv("N8N_BASE_URL"):
        return base_url.rstrip("/")
    
    return "http://localhost:5678"


# Configuration
N8N_BASE_URL = get_n8n_base_url()
N8N_API_KEY = os.getenv("N8N_API_KEY", "")

# Output directory (relative to this script)
OUTPUT_DIR = Path(__file__).parent / "workflows"


def fetch_projects(headers: dict) -> dict:
    """
    Fetch all projects from n8n API.
    
    Returns:
        dict mapping project ID to project name
    """
    projects = {}
    
    try:
        response = httpx.get(
            f"{N8N_BASE_URL}/api/v1/projects",
            headers=headers,
            timeout=30
        )
        response.raise_for_status()
        data = response.json()
        
        for project in data.get("data", []):
            projects[project["id"]] = project.get("name", "Unknown")
    except httpx.HTTPStatusError as e:
        if e.response.status_code != 404:
            print(f"  Warning: Could not fetch projects: HTTP {e.response.status_code}")
    except Exception as e:
        print(f"  Warning: Could not fetch projects: {e}")
    
    return projects


def get_workflow_folder(workflow: dict, full_workflow: dict, projects: dict) -> str:
    """
    Determine the folder name for a workflow based on its project or tags.
    
    Checks in order:
    1. homeProject.name (n8n 1.x projects)
    2. projectId mapped to projects dict
    3. First tag name
    4. Falls back to empty string (root folder)
    """
    # Check for homeProject (n8n 1.x+)
    home_project = full_workflow.get("homeProject") or workflow.get("homeProject")
    if home_project and isinstance(home_project, dict):
        project_name = home_project.get("name")
        if project_name:
            return project_name
    
    # Check for projectId
    project_id = full_workflow.get("projectId") or workflow.get("projectId")
    if project_id and project_id in projects:
        return projects[project_id]
    
    # Check for tags
    tags = full_workflow.get("tags") or workflow.get("tags") or []
    if tags and len(tags) > 0:
        if isinstance(tags[0], dict):
            return tags[0].get("name", "")
        elif isinstance(tags[0], str):
            return tags[0]
    
    return ""


def sanitize_folder_name(name: str) -> str:
    """Sanitize a string for use as a folder name."""
    if not name:
        return ""
    return "".join(c if c.isalnum() or c in " -_" else "_" for c in name).strip()


def fetch_workflows(headers: dict, active: bool | None = None) -> list:
    """
    Fetch workflows from n8n API.
    
    Args:
        headers: API headers with authentication
        active: None=all, True=active only, False=archived only
    """
    params = {}
    if active is not None:
        params["active"] = str(active).lower()
    
    all_workflows = []
    cursor = None
    
    while True:
        if cursor:
            params["cursor"] = cursor
        
        response = httpx.get(
            f"{N8N_BASE_URL}/api/v1/workflows",
            headers=headers,
            params=params,
            timeout=30
        )
        response.raise_for_status()
        data = response.json()
        
        workflows = data.get("data", [])
        all_workflows.extend(workflows)
        
        # Check for pagination
        cursor = data.get("nextCursor")
        if not cursor:
            break
    
    return all_workflows


def export_all_workflows(include_archived: bool = False, organize_by_folder: bool = False):
    """Export all workflows from n8n to individual JSON files."""
    
    if not N8N_API_KEY:
        print("❌ Error: N8N_API_KEY is required!")
        print(f"   Add it to: {env_path}")
        print("   Example: N8N_API_KEY=n8n_api_xxxxxxxxxxxxxxxx")
        print("   Generate one in n8n: Settings → API → Create API Key")
        return
    
    output_path = OUTPUT_DIR
    output_path.mkdir(parents=True, exist_ok=True)
    
    headers = {
        "X-N8N-API-KEY": N8N_API_KEY,
        "Accept": "application/json"
    }
    
    try:
        print(f"Connecting to n8n at: {N8N_BASE_URL}")
        
        # Fetch projects if organizing by folder
        projects = {}
        if organize_by_folder:
            print("Fetching projects...")
            projects = fetch_projects(headers)
            if projects:
                print(f"  Found {len(projects)} projects")
        
        # Fetch active workflows
        print("Fetching active workflows...")
        workflows = fetch_workflows(headers, active=True)
        print(f"  Found {len(workflows)} active workflows")
        
        # Optionally fetch archived workflows
        if include_archived:
            print("Fetching archived workflows...")
            archived = fetch_workflows(headers, active=False)
            print(f"  Found {len(archived)} archived workflows")
            workflows.extend(archived)
        
        print(f"\nExporting {len(workflows)} workflows...\n")
        
        exported_count = 0
        folders_created = set()
        
        for wf in workflows:
            wf_id = wf["id"]
            wf_name = wf["name"]
            
            try:
                # Get full workflow details
                detail_response = httpx.get(
                    f"{N8N_BASE_URL}/api/v1/workflows/{wf_id}",
                    headers=headers,
                    timeout=30
                )
                detail_response.raise_for_status()
                full_workflow = detail_response.json()
                
                # Determine target folder
                if organize_by_folder:
                    folder_name = sanitize_folder_name(
                        get_workflow_folder(wf, full_workflow, projects)
                    )
                    if folder_name:
                        target_dir = output_path / folder_name
                        if folder_name not in folders_created:
                            target_dir.mkdir(parents=True, exist_ok=True)
                            folders_created.add(folder_name)
                    else:
                        target_dir = output_path
                else:
                    target_dir = output_path
                
                # Sanitize filename
                safe_name = "".join(c if c.isalnum() or c in " -_" else "_" for c in wf_name)
                filename = target_dir / f"{safe_name}_{wf_id}.json"
                
                with open(filename, "w", encoding="utf-8") as f:
                    json.dump(full_workflow, f, indent=2, ensure_ascii=False)
                
                status = "" if wf.get("active", True) else " [archived]"
                folder_info = f" → {folder_name}/" if organize_by_folder and folder_name else ""
                print(f"✓ Exported: {wf_name}{status}{folder_info}")
                exported_count += 1
                
            except httpx.HTTPStatusError as e:
                print(f"✗ Failed to export '{wf_name}': HTTP {e.response.status_code}")
            except Exception as e:
                print(f"✗ Failed to export '{wf_name}': {e}")
        
        print(f"\n{'='*50}")
        print(f"Exported {exported_count}/{len(workflows)} workflows")
        if organize_by_folder and folders_created:
            print(f"Organized into {len(folders_created)} folder(s)")
        print(f"Saved to: {output_path.absolute()}")
        
    except httpx.HTTPStatusError as e:
        print(f"❌ HTTP Error: {e.response.status_code}")
        if e.response.status_code == 401:
            print("   Invalid API key. Check your N8N_API_KEY.")
        elif e.response.status_code == 403:
            print("   API key doesn't have permission to access workflows.")
    except httpx.ConnectError:
        print(f"❌ Connection Error: Could not connect to {N8N_BASE_URL}")
        print("   Make sure n8n is running and the URL is correct.")
    except Exception as e:
        print(f"❌ Error: {e}")


if __name__ == "__main__":
    include_archived = "--include-archived" in sys.argv or "-a" in sys.argv
    organize_by_folder = "--organize-by-folder" in sys.argv or "-f" in sys.argv
    
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        sys.exit(0)
    
    export_all_workflows(
        include_archived=include_archived,
        organize_by_folder=organize_by_folder
    )

