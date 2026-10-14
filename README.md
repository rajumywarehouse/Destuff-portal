# CFS Destuffing Portal: deploy guide

One website, two portals:

- **Staff portal:** inventory grid, strict FIFO job queue, live destuffing clocks, photos and files, audit log, users and customers.
- **Customer portal:** each customer signs in and sees only their own containers, their queue position and any photos you share with them.

The site is hosted on **Vercel** (free plan). Data, logins and files live in **Supabase** (free plan). Allow about 20 minutes.

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | The website (one page that shows the staff portal or the customer portal, depending on who signs in) |
| `assets/config.js` | **The only file you edit**: your Supabase address and key |
| `assets/core.js`, `staff.js`, `customer.js`, `app.css` | Portal code and design |
| `supabase/schema.sql` | Database tables, security rules and the FIFO logic. Run it once in Supabase. |
| `vercel.json` | Vercel settings and security headers |

---

## Step 1: Create the Supabase project

1. Go to **supabase.com**, sign up, and click **New project**.
2. Name it `cfs-portal`, set a strong database password (save it), and pick region **Mumbai (ap-south-1)**.
3. Wait about 2 minutes for it to finish setting up.

## Step 2: Create the database

1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this folder, copy all of it, paste it in and click **Run**.
3. You should see "Success. No rows returned". You can safely run it again later if you update the portal.

## Step 3: Get your two keys

1. In Supabase, open **Project Settings → API** (on newer dashboards: **Project Settings → Data API** and **API Keys**).
2. Copy the **Project URL** (looks like `https://abcdxyz.supabase.co`).
3. Copy the **anon public** key: a long text starting `eyJ…`. On newer dashboards it's under the **Legacy API Keys** tab. The newer `sb_publishable_…` key also works; if sign-in fails with it, use the legacy anon key.
   - Never use the `service_role` / secret key in this website.

## Step 4: Put the keys in the portal

Open `assets/config.js` and replace the two placeholder values:

```js
SUPABASE_URL: "https://abcdxyz.supabase.co",
SUPABASE_ANON_KEY: "eyJhbGciOi....",
COMPANY_NAME: "Your CFS name",
SLA_MINUTES: 120
```

The anon key is meant to be public. Your data is protected by the database rules from Step 2, not by hiding this key.

## Step 5: Publish on Vercel

**Option A: drag and drop (no GitHub needed)**

1. Install the Vercel command line: `npm i -g vercel`
2. Open a terminal in this folder and run: `vercel --prod`
3. Log in when asked, and accept the defaults (framework: **Other**, no build command).

**Option B: through GitHub (best for future updates)**

1. Create a new GitHub repository and upload all files in this folder (keep the folder structure).
2. In Vercel, click **Add New → Project**, import the repository, set Framework Preset to **Other**, leave Build Command empty and click **Deploy**.
3. Every later change you push to GitHub redeploys automatically.

Vercel gives you an address like `https://cfs-portal.vercel.app`. You can add your own domain (e.g. `portal.yourcfs.in`) under **Vercel → Project → Settings → Domains**.

## Step 6: Tell Supabase your website address

In Supabase, open **Authentication → URL Configuration**:

- **Site URL:** your Vercel address, e.g. `https://cfs-portal.vercel.app`
- **Redirect URLs:** add the same address.

Without this, email confirmation and password-reset links will point to the wrong place.

## Step 7: Create your superadmin account (do this straight away)

1. Open your Vercel address, click **Create account** and sign up with your own email.
2. Confirm the email, then sign in.

**The first account ever created becomes the superadmin automatically.** Everyone after that waits for approval. So create yours before you share the link.

If someone else got in first, fix it in Supabase SQL Editor:

```sql
update profiles set role = 'superadmin' where email = 'you@yourcompany.com';
update profiles set role = 'pending'    where email = 'whoever@else.com';
```

## Step 8: Add customers and people

In the portal, open **Users & customers**.

1. **Add customers:** give each one a short code (e.g. `ABCIMP`) and a name.
2. **Staff:** ask staff to create an account from the sign-in page. They appear at the top as *Waiting for approval*. Give each one a role:

   | Role | Can do |
   |---|---|
   | Superadmin | Everything, including FIFO bypass, priority, user management |
   | Operations + Supervisor | Inventory and starting/completing jobs |
   | Operations team | Inventory only |
   | Warehouse supervisor | Start/complete jobs and photos |
   | Read only | View everything, change nothing |

3. **Customers:** ask each customer contact to create an account. Set their role to **Customer** and pick their company in the Customer column. One company can have several logins.
4. **Inventory:** put the customer code in the **Customer** column of each container (or in the Excel upload). Only containers with that customer's code appear on their portal.
5. **Photos:** in a container's photos and files, tick **Customer can see** on any file you want to share. Files are private to staff until you tick it.

## Recommended Supabase settings

- **Authentication → Providers → Email:** keep **Confirm email** on.
- **Authentication → Emails:** Supabase's built-in email sender is rate-limited (only a few emails per hour). Before going live with many customers, add your own SMTP in **Authentication → SMTP Settings** (Gmail Workspace, Zoho or Amazon SES all work).
- **Free plan pauses after 7 days of no activity.** Daily use keeps it awake. Upgrade to the Pro plan ($25/month) for production use and daily backups.
- **Storage:** the free plan includes 1 GB for photos and files. Photos are resized to about 200–400 KB each.

## How the security works

- **FIFO is enforced by the database.** The Start button calls a database function that checks the queue order, the person's role and the bypass reason. Even someone calling the database directly cannot skip the queue without being a superadmin.
- **Job fields are locked.** Status, start and finish times, mode and durations can only change through Start, Complete and Requeue. Saved arrival times (which set FIFO order) can only be changed by a superadmin, and every change is logged.
- **Customers never read the containers table directly.** They get a limited view of their own containers only: no staff names, no audit log, no bypass reasons, and no other customers' data.
- **New sign-ups see nothing** until a superadmin assigns a role.

## Updating later

- **Portal changes:** replace the files and redeploy (`vercel --prod`, or push to GitHub).
- **Database changes:** run the new `schema.sql` again in the SQL Editor. It updates in place without deleting data.
