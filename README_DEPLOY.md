# BaoKhang Vocab

Static vocabulary learning app for GitHub Pages.

## Admin login

- Username: `BaoKhang`
- Password: `Kn6761617`

## Deploy on GitHub Pages

1. Create a new public GitHub repository.
2. Upload `index.html`, `style.css`, and `script.js` to the repository root.
3. Open **Settings > Pages**.
4. Choose **Deploy from a branch**.
5. Select branch `main` and folder `/root`.
6. Save. GitHub will publish the app after a short build.

## Data note

This is a static GitHub Pages app, so user accounts, folders, files, vocabulary,
and learning progress are saved in browser `localStorage`. Use the built-in
Export/Import buttons to save workspace JSON files into Google Drive manually.

Google Drive JSON sync is wired through `CLOUD_SYNC_URL` and `CLOUD_FOLDER_ID`
in `script.js`. The Web App should accept the actions `login`,
`saveUserWorkspace`, and `saveAllUsers`.

Keep the private token in Google Apps Script `Script Properties`, not in public
JavaScript. The provided token should not be committed to GitHub.
