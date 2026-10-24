# Google Drive auto backup: one-time setup

Do steps 2 to 4 on a computer if possible (Google Cloud Console is hard to use on a phone).
Replace USERNAME with your GitHub username (lowercase) everywhere below.

## 1. Put the app on GitHub Pages
1. github.com > sign up > + > New repository > name: hisaab > Public > Create.
2. "uploading an existing file" > select all files from the hisaab folder > Commit changes.
3. Settings > Pages > Branch: main, /(root) > Save. After 1-2 minutes your link is:
   https://USERNAME.github.io/hisaab/
4. Open it once to check it loads.

## 2. Create a Google Cloud project
1. Open console.cloud.google.com and sign in with the Gmail where backups should go.
2. Top bar: project picker > New project > name: hisaab > Create. Make sure it is selected.
3. Search bar: "Google Drive API" > open it > Enable.

## 3. Set up the sign-in screen
1. Search bar: "Google Auth Platform" (or menu > APIs & Services > OAuth consent screen) > Get started.
2. App name: Hisaab. User support email: your Gmail. Next.
3. Audience: External. Next.
4. Contact email: your Gmail. Next. Tick "I agree". Continue > Create.
5. Left menu: Audience > Test users > Add users > your Gmail > Save.
6. Left menu: Data access > Add or remove scopes > search "drive.file" > tick
   ".../auth/drive.file" > Update > Save.

## 4. Create the Client ID
1. Left menu: Clients > Create client.
2. Application type: Web application. Name: Hisaab.
3. Authorized JavaScript origins > Add URI:
   https://USERNAME.github.io
4. Authorized redirect URIs > Add URI:
   https://USERNAME.github.io/hisaab/
   (must end with a slash, must match exactly)
5. Create. Copy the Client ID (ends with .apps.googleusercontent.com). You do not need the client secret.

## 5. Put the Client ID in the app
1. GitHub > your hisaab repository > config.js > pencil icon (Edit).
2. Paste the Client ID between the quotes:
   googleClientId: '1234-abcd.apps.googleusercontent.com'
3. Commit changes. Wait 1-2 minutes.

## 6. Connect on your phone
1. Open https://USERNAME.github.io/hisaab/ in Chrome. Pull down to refresh once.
2. Menu (⋮) > Add to Home screen / Install app. From now on open the app from the home screen icon.
3. In the app: More > Backup & restore > Connect Google Drive.
4. Choose your Gmail. Google shows "Google hasn't verified this app": tap Continue
   (this is normal for your own personal app). Allow access. You return to the app.
5. Status should say "Up to date". In Google Drive you will see the folder "Hisaab Backups".

## 7. Test restore once (2 minutes, do not skip)
On another phone, or in a Chrome Incognito tab: open the link > More > Backup >
Restore from Google Drive > pick today's backup. Your entries should appear.
Close the incognito tab afterwards.

## If something goes wrong
- "redirect_uri_mismatch": the redirect URI in step 4.4 does not exactly match your link.
  It must be https://USERNAME.github.io/hisaab/ with the final slash.
- "access blocked / not a test user": add your Gmail under Audience > Test users.
- Home screen says "Google Drive backup paused": tap it and sign in again.
- Still showing old version after changing config.js: close the app fully and open again,
  or open the link in Chrome and refresh.
