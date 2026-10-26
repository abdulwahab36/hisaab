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
On first open, Hisaab shows a short welcome: enter your account balances and pick your areas (Home, Office…), or try it with sample data first. The steps below are for later changes.

1. ☰ > Accounts: set the opening balance of Cash, Bank, Easypaisa, JazzCash (edit names/add more).
2. People: add friends, staff, and your office/company as a person (type "Office / company").
3. ☰ > Projects / sites: add works you spend on (optional).
4. Add entries with the + button. Tick "Save as quick template" for anything you repeat.
5. ☰ > Backup: back up weekly (share the file to Google Drive or WhatsApp yourself).

## Adding money: who and what
Tap + and choose Money out or Money in.
- Money out > For whom? Pick Me (your own spending) or a person, then answer What is this money?
  - Not coming back: a gift, a treat, or a fee you paid for them. Counts as your spending; Insights > Spent on people shows the total.
  - Coming back: they will return it, or the office will reimburse you.
  - To spend for me: they buy something for you and give back the change. When they tell you what they spent, open their page > They paid a bill or bought something for me.
  - Paying back what I owe: shown only when you owe that person.
- Money in > From whom? Pick Income (salary, TA) or a person, then Paying me back or Lending me.
- Paid from lists your accounts, plus anyone holding money you gave them to spend for you. Choose "Someone else paid for me…" when a friend or relative paid (you will owe them).
- Date: Today, Yesterday or Other date, right under the amount.
- Paying a bill? When a bill is due within a week, it appears under the category; tap it to fill the amount and mark the bill paid.
- Money in from someone with open items (for example the office): "Paying back items" lets you choose which items the money covers, so each one closes.

## Entry types
- My expense: your own spending. Only this (plus write-offs and balance-check gaps) counts as "Spent".
- To get back (For: a person, pay back Yes): you paid, office/company/someone repays you later. Shows under "To get back" on that person's page until paid back or written off.
- Paid from a person: on Expense/Recoverable, pick a staff member under "Paid from" when they spend from your advance (or pay for you).
- Advance / Got back: money given to staff, and unused cash returned.
- Loans and advances: open the person in People and tap I gave or I received. The app labels it (loan, advance, paying back) from their balance. Settle up fills in the exact amount to clear the balance.
- Bills: pick a bill type from the grid (Electricity, Gas, Water, Internet, Mobile, Rent, School fee, Committee…), name it (LESCO, Netflix), set how often (weekly to yearly) and the account you usually pay from. Tap Pay with the real amount; the next one is created automatically.
- Bottom bar: Home, People, +, Bills, Insights. On Home, the top row has ☰ (menu with backup status, Budgets, Accounts, Backup, Preferences and other settings), the period switcher, and 🔥 (recording streak). "See full breakdown" under the Home summary opens Insights for the same period.
- Home: spending for this week, last week, this month, a past month or custom dates (tap the period name). Cash and bank totals are under ☰ > Accounts.
- Insights: own spending by category and area, categories above your usual, biggest expenses, last 6 months.
- Budgets (☰ > Budgets): a monthly limit for all spending, and optional limits per category or area. The marker on each bar shows how far through the month you are. Home shows the overall budget; Needs attention warns at 90% and when over.
- Streak (🔥 on Home, top right): days in a row with something recorded. Tap "Nothing spent today" on days without spending. Hollow dots are missed days: tap one to add that day's spending or mark it as nothing spent.
- ☰ > Preferences: appearance (same as phone, light, dark), text size, currency symbol, number style.
- Home-screen shortcuts: long-press the installed Hisaab icon for Add expense, Bills and People.
- After saving, tap Undo in the message at the bottom within 5 seconds to take it back.

## Help inside the app
☰ > How to use Hisaab: every task explained in plain steps with examples, with a search box.

## Files
index.html, style.css, app.js, config.js, sw.js, manifest.json (includes the home-screen shortcuts), icons, and the fonts folder (3 small font files, needed for the look and offline use).

## Google Drive auto backup
One-time setup (about 15 minutes, free): see SETUP-GOOGLE-DRIVE.md.
After that the app saves to your Drive folder "Hisaab Backups" after every change. Your Google sign-in lasts 1 hour; after that the app briefly jumps to Google and back (about a second) to refresh it. The last 15 days are kept. Receipt photos are saved in Hisaab Backups/receipts.
New phone: install the app, ☰ > Backup > Restore from Google Drive.

## APK
See GET-APK.md (free, via PWABuilder). Not required: installing from Chrome gives the same app.

## Updating the app later
Replace the files on your host and change VERSION in sw.js (e.g. hisaab-v2) so phones pick up the new version. Your data is not affected.

## Not included yet
- Reading Easypaisa/JazzCash/bank SMS: needs an Android APK wrapper (Capacitor), not possible in a web app.
- Live share links where the other person confirms entries: needs a backend. For now, share statements by WhatsApp or PDF.
- Data from your old ExpenseFlow version is not imported (different data structure).
