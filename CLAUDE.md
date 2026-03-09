# WhatsApp Bot Project

## Overview
This is a WhatsApp bot built using the wppconnect library. The bot provides automated messaging and file handling capabilities.

## Project Structure
```
WHATS_BOT/
├── src/
│   ├── index.js          # Main entry point
│   ├── handlers/         # Message and event handlers
│   ├── services/         # Business logic and external services
│   └── data/             # Data storage and configuration
├── downloads/            # Downloaded files
├── tokens/               # Authentication tokens
├── .env                  # Environment variables
└── package.json          # Dependencies and scripts
```

## Tech Stack
- **wppconnect**: WhatsApp Web API integration
- **axios**: HTTP client for API requests
- **dotenv**: Environment variable management
- **form-data**: Multipart form data handling
- **mime-types**: File type detection

## Setup
1. Install dependencies: `npm install`
2. Configure environment variables in `.env`
3. Run the bot: `node src/index.js`

## Environment Variables
Check `.env` file for required configuration variables.

## Development Notes
- Bot uses WhatsApp Web protocol via wppconnect
- Authentication tokens stored in `tokens/` directory
- Media files downloaded to `downloads/` directory
- Python virtual environment in `venv/` (legacy?)

## Common Tasks
- Starting the bot: `node src/index.js`
- Installing new dependencies: `npm install <package-name>`
- Checking logs: Review console output or log files

## Important Files
- `src/index.js` - Application entry point
- `.env` - Configuration and credentials (DO NOT commit)
