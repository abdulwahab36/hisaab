# Hisaab

Personal money tracker: own spending, recoverables, people ledgers, staff advances, expected money.
Runs fully on your phone. No server, no account, no Play Store needed.

## Install on your phone (free)

Option A: GitHub Pages
1. Create a free GitHub account, make a new repository (Private is fine on a paid plan; on free plan use Public: only code is visible, your data stays on your phone).
2. Upload all files from this folder.
3. Settings > Pages > Branch: main > Save. Wait a minute for the link.
4. Open the link in Chrome on your phone > menu (⋮) > Add to Home screen.

Option B: Netlify
1. Go to app.netlify.com, sign in, choose "Deploy manually" and drag this folder in.
2. Open the link in Chrome > Add to Home screen.

Opening index.html directly as a file also works for testing, but offline install (home-screen app) needs one of the hosted options.

## First 5 minutes
1. More > Accounts: set the opening balance of Cash, Bank, Easypaisa, JazzCash (edit names/add more).
2. People: add friends, staff, and your office/company as a person (type "Office / company").
3. More > Works / sites: add works you spend on (optional).
4. Add entries with the + button. Tick "Save as quick template" for anything you repeat.
5. More > Backup: back up weekly (share the file to Google Drive or WhatsApp yourself).

## Entry types
- Expense: your own spending. Only this (plus write-offs and balance-check gaps) counts as "Spent".
- Recoverable: you paid, someone pays you back later. Stays in Pending until recovered or written off.
- Paid from a person: on Expense/Recoverable, pick a staff member under "Paid from" when they spend from your advance (or pay for you).
- Advance / Got back: money given to staff, and unused cash returned.
- Lent / Borrowed / Got back / Paid back: loans with people.
- Expected: future money in (TA, arrears, payouts) or out (bills). Monthly items repeat automatically.

## Google Drive auto backup
One-time setup (about 15 minutes, free): see SETUP-GOOGLE-DRIVE.md.
After that the app saves to your Drive folder "Hisaab Backups" after every change. Your Google sign-in lasts 1 hour; after that the app briefly jumps to Google and back (about a second) to refresh it. The last 15 days are kept. Receipt photos are saved in Hisaab Backups/receipts.
New phone: install the app, More > Backup > Restore from Google Drive.

## Updating the app later
Replace the files on your host and change VERSION in sw.js (e.g. hisaab-v2) so phones pick up the new version. Your data is not affected.

## Not included yet
- Reading Easypaisa/JazzCash/bank SMS: needs an Android APK wrapper (Capacitor), not possible in a web app.
- Live share links where the other person confirms entries: needs a backend. For now, share statements by WhatsApp or PDF.
- Data from your old ExpenseFlow version is not imported (different data structure).
