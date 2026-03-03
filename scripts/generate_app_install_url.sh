#!/usr/bin/env bash
set -euo pipefail
# This script opens the "Create GitHub App from manifest" flow:
# It prints the URL the user should visit to create the app.
MANIFEST=".github/app-manifest.yml"
if ! command -v gh >/dev/null; then
  echo "gh CLI not found; cannot create app via manifest flow programmatically."
  echo "Follow the manual steps below instead."
fi
# Use GitHub API to create manifest draft via /app-manifests endpoint requires interactive flow.
# Instead, output manual steps.
echo ""
echo "To create the GitHub App from the manifest, go to:"
echo "1) GitHub UI → Settings → Developer settings → GitHub Apps → 'Create GitHub App' and use the manifest below."
echo "2) Paste the contents of .github/app-manifest.yml and follow the wizard."
echo ""
echo "Manifest file location: $MANIFEST"
