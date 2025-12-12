#!/bin/bash

# Shell script that runs codex in non-interactive mode for each entry in scraper-ideas.txt
# Loops until the file is empty or contains only whitespace

SCRAPER_IDEAS_FILE="scraper-ideas.txt"

# Hardcoded prompt template - customize as needed
PROMPT_TEMPLATE="Scraper-ideas.txt contains ideas for more scraper targets. Pick the first one off the list, implement a scraper for it and test it. For testing, run the scraper with real data in the same way the web app would and make sure products and images are scraped correctly. If there are issues, try to fix them. If you cannot successfully implement a scraper, remove the entry from the list and put into a failed.txt file (append if it exists already). If you succeeded, just remove the line. This prompt and agent will be used for many more scrapers - if you make any learnings that are generalizable to other scrapers, please document them in the AGENTS.md file (append if it exists already)."

while true; do
    # Check if file exists
    if [[ ! -f "$SCRAPER_IDEAS_FILE" ]]; then
        echo "File $SCRAPER_IDEAS_FILE not found. Exiting."
        exit 0
    fi

    # Read the first non-empty line from the file
    first_line=""
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip empty lines and whitespace-only lines
        if [[ -n "${line// /}" ]]; then
            first_line="$line"
            break
        fi
    done < "$SCRAPER_IDEAS_FILE"

    # Check if we found a non-empty line
    if [[ -z "$first_line" ]]; then
        echo "No more entries in $SCRAPER_IDEAS_FILE. Done!"
        exit 0
    fi

    echo "=============================================="
    echo "Processing: $first_line"
    echo "=============================================="

    # Run codex in non-interactive mode with the prompt
    codex exec --yolo "$PROMPT_TEMPLATE"

    # Check exit status
    if [[ $? -ne 0 ]]; then
        echo "Warning: codex exec returned non-zero exit status"
    fi

    # Remove the first line from the file (including any leading empty lines up to it)
    # Create a temp file without the processed line
    tail -n +2 "$SCRAPER_IDEAS_FILE" > "${SCRAPER_IDEAS_FILE}.tmp"
    mv "${SCRAPER_IDEAS_FILE}.tmp" "$SCRAPER_IDEAS_FILE"

    echo ""
    echo "Completed processing. Moving to next entry..."
    echo ""
done
