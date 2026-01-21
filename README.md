# applicationsScience

A Forge application for Atlassian products (Jira, Confluence, etc.)

## About Forge

Forge is Atlassian's cloud app development platform. It allows you to build apps for Jira, Confluence, and other Atlassian products with modern web technologies.

## Prerequisites

- Node.js 18.x or later
- npm 8.x or later
- Forge CLI (install with `npm install -g @forge/cli`)

## Getting Started

### 1. Install Forge CLI

```bash
npm install -g @forge/cli
```

### 2. Login to Forge

```bash
forge login
```

This will open your browser to authenticate with Atlassian.

### 3. Install Dependencies

```bash
npm install
```

### 4. Register Your App

Before deploying, you need to register your app:

```bash
forge register
```

This will create a unique app ID in the manifest.yml file.

### 5. Deploy Your App

```bash
forge deploy
```

### 6. Install Your App

Install the app to an Atlassian site:

```bash
forge install
```

Select the product (e.g., Jira) and the site where you want to install the app.

## Development

### Project Structure

```
.
├── manifest.yml       # Forge app configuration
├── package.json       # Node.js dependencies
├── src/
│   └── index.js      # Main application code
└── README.md
```

### Local Development

For local development with hot reloading:

```bash
forge tunnel
```

This allows you to test your changes without deploying.

### View Logs

To view logs from your app:

```bash
forge logs
```

### Uninstall App

To uninstall the app from a site:

```bash
forge uninstall
```

## Manifest.yml

The `manifest.yml` file defines your app's configuration, including:
- Modules (UI extensions)
- Functions (backend logic)
- Permissions (API scopes)
- App metadata

## Resources

- [Forge Documentation](https://developer.atlassian.com/platform/forge/)
- [Forge API Reference](https://developer.atlassian.com/platform/forge/apis/)
- [Forge CLI Reference](https://developer.atlassian.com/platform/forge/cli-reference/)
- [Forge Community](https://community.developer.atlassian.com/c/forge/)

## License

ISC
