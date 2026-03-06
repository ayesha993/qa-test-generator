# QA Test Case Generator — Azure DevOps & Jira × Claude AI

## Project Structure

```
qa-app/
├── api/
│   ├── jira.js        ← Vercel serverless proxy for Jira (fixes CORS)
│   └── ado.js         ← Vercel serverless proxy for Azure DevOps (fixes CORS)
├── src/
│   ├── main.jsx
│   └── App.jsx
├── index.html
├── vite.config.js
├── vercel.json
└── package.json
```

## Deploy to Vercel (recommended)

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   gh repo create qa-test-generator --public --push
   ```

2. **Deploy on Vercel**
   - Go to [vercel.com](https://vercel.com) → New Project
   - Import your GitHub repo
   - Framework: **Vite**
   - Build command: `npm run build`
   - Output directory: `dist`
   - Click **Deploy**

   Vercel automatically picks up the `api/` folder as serverless functions — no extra config needed.

## Run Locally

```bash
npm install
npm run dev
```

> Note: Local dev calls the API proxies via Vite's dev server proxy config.
> For full local testing of serverless functions, install Vercel CLI:
> ```bash
> npm i -g vercel
> vercel dev
> ```

## Credentials needed

**Azure DevOps**
- Organization name
- Project name  
- Personal Access Token (PAT) with: Work Items Read/Write + Test Management Read/Write

**Jira**
- Base URL: `https://yourorg.atlassian.net`
- Project Key: e.g. `PROJ`
- Email address
- API Token from: https://id.atlassian.com/manage-profile/security/api-tokens
