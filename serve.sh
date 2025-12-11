#!/bin/bash
# Start webserver and worker with auto-restart

cd "$(dirname "$0")"

# Activate virtual environment
source venv/bin/activate

# Run the serve command
python -m src.cli --serve
