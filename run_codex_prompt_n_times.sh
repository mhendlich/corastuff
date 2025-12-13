#!/bin/bash

# Shell script that runs codex in non-interactive mode N times with a hardcoded prompt.

# Hardcoded prompt - customize as needed
PROMPT_TEMPLATE="We are currently reimplementing this python webapp in a modern tech stack to enable live ui updates in the new subfolder. Look at TODO.md for a list of things that still need to be done. Pick one or more items and implement and test them. When done, take them off the list. Feel free to add additional things to the list or adjust other entries based off your work as a handoff. Make sure that before you end your run, you restart the services using docker compose so i can always see the newest version in the browser. Do not skip TODOs in the list. Roughtly follow from top to bottom. Keep this order in mind when you update and insert new TODOs. I dont care about migrating data from the old to the new system. If you have any learnigns during this process that would benefit the next agent, add them to the learnings.md file and read it before starting so you have the knowledge of the last agents. Feel free to correct and update old entries in there too"

N="${1:-1}"

if ! [[ "$N" =~ ^[0-9]+$ ]] || [[ "$N" -le 0 ]]; then
    echo "Usage: $0 <positive-integer-N>"
    exit 2
fi

for ((i = 1; i <= N; i++)); do
    echo "=============================================="
    echo "Run $i / $N"
    echo "=============================================="

    codex exec --yolo "$PROMPT_TEMPLATE"
    exit_status=$?

    if [[ $exit_status -ne 0 ]]; then
        echo "Warning: codex exec returned non-zero exit status: $exit_status"
    fi

    echo ""
done
