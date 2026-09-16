# Connecting Google

Gmail and Google Photos need an OAuth client ID. It is **your** client ID, it
lives on your device, and there is no client secret — this app has no server to
keep one in. Location does not need any of this; it comes from a file export.

Budget about ten minutes, once.

## 1. Create a project

Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a
project. Any name.

## 2. Enable the two APIs

Under **APIs & Services → Library**, enable:

- **Gmail API**
- **Photos Picker API** — note: *Picker*, not "Photos Library API". The Library
  API no longer returns media your app didn't create.

## 3. Configure the consent screen

**APIs & Services → OAuth consent screen**:

- User type: **External**
- Fill in app name and your email
- Under **Audience**, add your own Google account as a **test user**

Add these scopes:

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/photospicker.mediaitems.readonly
```

Leave the app in **Testing**. You do not need Google to verify it — verification
exists for apps distributed to other people, and this one is yours. The cost of
staying in testing is that you re-consent periodically.

## 4. Create the client ID

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**
- **Authorized JavaScript origins** — add every origin you will open the app
  from, exactly, with no trailing slash:
  - `http://localhost:5173` (development)
  - `https://your-deployment-host` (whatever you deploy to)

There is no redirect URI to set: tokens come back to the page itself.

Copy the client ID — it ends in `.apps.googleusercontent.com`.

## 5. Paste it into the app

Open **Sources → Settings** and paste it into *Google OAuth client ID*. It is
stored in this browser's `localStorage` and used only to talk to Google.

For development you can instead put it in a `.env.local` file:

```
VITE_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
```

## What you are actually granting

| Scope | What it permits | What this app does with it |
|---|---|---|
| `gmail.readonly` | Read all mail | Requests `format=metadata` only — From, To, Subject, Date. Bodies are never fetched. |
| `photospicker.mediaitems.readonly` | Read items **you pick**, for one session | Reads capture time and downloads a 320px thumbnail. |

Access tokens last about an hour, live in `sessionStorage`, and are never
written to the database. **Sources → Settings → Remove** revokes them.

## Known limits

- **No location, at any scope.** Google retired the Location History API and
  moved Timeline on-device. Nothing you enable here will put you on the map —
  use the Location Timeline import.
- **The picker strips GPS.** Photos imported through Google Photos carry a
  timestamp but no coordinates. Import the photo *files* if you want photos to
  place themselves on the map.
- **Testing-mode consent expires.** You will be asked to re-authorize
  periodically. Publishing the app to "In production" stops that, at the cost
  of a Google verification review.
