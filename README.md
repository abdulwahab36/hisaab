# Hisaab

Personal money tracker: own spending, recoverables, people ledgers, money given to others to spend for you, expected money.
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
2. People: add family, friends, people who spend money for you, and your office/company (type "Office / company (pays me back)").
3. ☰ > Projects / sites: add works you spend on (optional).
4. Add entries with the + button. Tick "Save as quick template" for anything you repeat.
5. ☰ > Backup: back up weekly (share the file to Google Drive or WhatsApp yourself).

## Adding money
- Everyday (most entries): + > amount > category > Save. Paid from and Date (shows Today) are right there if you need to change them.
- For family, friends or the office: tap "For someone else?" under the amount, or open the person in People and tap "I gave / paid" or "I received". Then choose what the money is:
  - Money out: Not coming back (gift, treat, fee you paid for them) · Coming back (loan, or office will reimburse) · To spend for me (they buy things for you and return the change) · Paying back what I owe.
  - Money in: Paying back items · Paying me back / Returning unused money · Lending me · Paid something for me (you will owe them).
- The most likely choice is already selected: family = Not coming back, office = Coming back, spends money for me = To spend for me, friend = Coming back, anyone you owe = Paying back.
- Settle up on a person's page fills the exact amount and uses the same steps.

## Entry types
- My expense: your own spending. Only this (plus write-offs and balance-check gaps) counts as "Spent".
- To get back (For: a person, pay back Yes): you paid, office/company/someone repays you later. Shows under "To get back" on that person's page until paid back or written off.
- Paid from a person: on Expense/Recoverable, pick that person under "Paid from" when they spend from your advance (or pay for you).
- Advance / Got back: money given to someone to spend for you, and unused cash returned.
- Loans and advances: open the person in People and tap I gave or I received. The app labels it (loan, advance, paying back) from their balance. Settle up fills in the exact amount to clear the balance.
- Bills: pick a bill type from the grid (Electricity, Gas, Water, Internet, Mobile, Rent, School fee, Committee…), name it (LESCO, Netflix), set how often (weekly to yearly) and the account you usually pay from. Tap Pay with the real amount; the next one is created automatically.
- Bottom bar: Home, People, +, Bills, Insights. On Home, the top row has ☰ (menu with backup status, Budgets, Accounts, Backup, Preferences and other settings), the period switcher, and 🔥 (recording streak). "See full breakdown" under the Home summary opens Insights for the same period.
- Home: spending for this week, last week, this month, a past month or custom dates (tap the period name). Cash and bank totals are under ☰ > Accounts.
- Budgets (☰ > Budgets): a monthly limit for all spending, and optional limits per category or area. The marker on each bar shows how far through the month you are. Home shows the overall budget; Needs attention warns at 90% and when over.
- Streak (🔥 on Home, top right): days in a row with something recorded. Tap "Nothing spent today" on days without spending. Hollow dots are missed days: tap one to add that day's spending or mark it as nothing spent.
- ☰ > Preferences: appearance (same as phone, light, dark), text size, currency symbol, number style.
- Home-screen shortcuts: long-press the installed Hisaab icon for Add expense, Bills and People.
- After saving, tap Undo in the message at the bottom within 5 seconds to take it back.

## Home and Insights
- Home > Add again: the things you enter most often (fuel, milk…) appear automatically. One tap opens the form already filled; change the amount if needed and Save.
- Insights has three tabs. Overview: spent with a pace line vs last month and a month-end projection, income/saved, budget ring, category donut (tap for entries), area tiles with change vs last month, paid with, bills, biggest expenses, month-by-month columns. Projects: one card per project/site with total, own vs to-be-repaid split, still to get back and cash with people. People: who owes you, whom you owe, spent on each person.
- Adding a person: choose who they are (Family / relative, Friend, Spends money for me, Office / company (pays me back), Other). The short explanation under the choice shows what it means; it decides which option is pre-selected when you add money for them.

## Bills and bank messages
- Each bill has its own page (tap it in Bills): every month's amount, average, highest, lowest, last vs previous, units and cost per unit, late payments, and a month-by-month chart.
- The next bill of a repeating bill is estimated (≈) from history: same month last year if known, else the average of the last 3. Enter the real amount when the bill arrives, or at Pay.
- Reference / consumer no. on the bill with a Copy button; Transaction ID and units on each payment.
- Share a bank SMS to Hisaab (or copy it and tap Paste bank SMS on Home): amount, date, name, account and Tx ID fill in; the same Tx ID is never added twice; an A/C number is matched to your account after the first time.

## Area
- The Area line sits under the category on the add form. It fills itself from the category (Fuel → where you usually put fuel), never from your last entry, so one area can't silently leak into the next record. Change it in one tap; a hand-picked area is kept for "Save and add another".

## App lock, projects and lists (v36)
- App lock: 4 or 6 digit PIN that moves on by itself, optional fingerprint unlock, "Wrong PIN · N tries left", 30-second wait after 5 wrong tries. Lock now is in the ☰ menu.
- Add form: a Project line under Area appears once you have an open project; it always starts at None.
- Areas, Categories and Projects lists show entries and this month's amount; tap a row for its entries, the pencil to edit. Project page: total, own vs to be repaid, still to get back, cash with people, what it went on, month by month.
- ☰ menu grouped into Money, Organise and App.

## v37
- Projects list works like People: Open / Finished / All, search, + Project; each row shows only the name and amount. Tap › for everything else.
- Project page: Edit · Share · PDF under the name; optional estimate with % used; + Spent, Gave to spend, Got paid back; this month, still to get back, cash with people; what it went on; month by month; entries by month with filters; Mark as finished.
- Person page: Edit · Share · Call under the name.
- Add form: the 6 most used categories, most used first; "All" / "More…" shows the rest.
- ☰ menu: icons, Money / Organise / App sections, short values on the right.

## v38
- Add again: pin any entry (open it → Pin to Home); quick templates are gone. Paste bank SMS and Snap receipt are on the Add screen.
- To get back now lives in People → Owe me (with "How old"); money you are waiting for (TA, arrears) is in Bills → Money coming in.
- Accounts: tap one for its statement, month by month, with the balance after every entry; Fix balance, Edit and Export are there.
- Recently deleted (☰): deleted entries are kept 30 days and can be restored.
- Export: All entries → Export → Excel (.csv) or PDF. Insights → Share summary on WhatsApp.
- Entry details: Copy for today, Pin to Home, Share receipt, "all ›" for the category.
- Bills: Remind me in Calendar (Google Calendar, repeating, 2 days before due).
- Vehicle projects: tick "This is a vehicle" on a project, type litres and odometer with fuel; the project shows km per litre, cost per km, km driven and a fuel log.
- Budgets: how much a day keeps you inside the budget.

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
