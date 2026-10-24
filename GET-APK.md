# Getting a Hisaab APK (free)

First: you may not need one. "Add to Home screen / Install app" in Chrome already gives
you a full-screen app with its own icon that works offline. An APK made the way below
behaves the same; it does not add SMS reading (that needs the Capacitor build, see the end).

An APK is useful if you want to: send the app file to someone, install without opening
Chrome first, or later publish to the Play Store.

## Make the APK with PWABuilder (about 10 minutes, on a computer)
1. Make sure the latest files are on GitHub and https://abdulwahab36.github.io/hisaab/ opens.
2. Go to https://www.pwabuilder.com
3. Paste: https://abdulwahab36.github.io/hisaab/  and press Start. Wait for the report.
4. Click "Package for stores" > Android > "Generate Package".
5. In the options:
   - Package ID: com.hisaab.app (any unique name, keep it forever)
   - App name: Hisaab
   - Signing key: "Create new"
   - Leave the rest as is.
6. Download. You get a zip containing:
   - app-release-signed.apk  (this is the file you install)
   - signing.keystore and signing-key-info.txt  (KEEP BOTH SAFE: you need the same
     key to build updates; without it a new APK cannot replace the old one)

## Install on your phone
1. Send app-release-signed.apk to your phone (USB, Google Drive, or WhatsApp to yourself).
2. Tap the file. Android asks to allow "Install unknown apps" for that app (Files/Drive/WhatsApp): allow it once.
3. Tap Install. If Play Protect warns, tap "More details" > "Install anyway" (normal for apps not from the Play Store).

## Your data
The APK runs inside Chrome on the same web address, so it should open with the same data
as the app you installed from Chrome. If it opens empty, go to More > Backup >
Restore from Google Drive. Use only one of them afterwards (APK or Chrome app), not both.

## Optional: hide the address bar at the top
Without this step the APK shows a small Chrome bar at the top. To remove it:
1. On GitHub create a new public repository named exactly: abdulwahab36.github.io
2. Add a file .well-known/assetlinks.json with the content PWABuilder gives you
   (it is inside the downloaded zip as assetlinks.json).
3. Settings > Pages > Branch main > Save. Wait 2 minutes and reopen the APK.

## Updating
Normal updates (new app.js etc. on GitHub) reach the APK automatically; you do NOT need
a new APK. Rebuild the APK only if you change the app name, icon or package.

## Real native app (for SMS reading later)
Reading Easypaisa/JazzCash/bank SMS needs a Capacitor build made in Android Studio on your
computer. That is a separate step for version 2.
