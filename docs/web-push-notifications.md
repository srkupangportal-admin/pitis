# Web Push notifications

SchoolPortal stores every notification in SQLite first; Web Push is an optional additional delivery channel. `notificationService.notifyUser()` creates the history record, applies the user's module preferences, and sends to every enabled subscription owned by that user. HTTP 404/410 push endpoints are disabled automatically.

## Configure VAPID

Run `npx web-push generate-vapid-keys` once on an administrator workstation. Put the public key, private key, and a `mailto:` or HTTPS contact in the private server environment file as `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`. Never commit the private key. Restart SchoolPortal after configuration.

Users open Notification Settings and explicitly enable each browser/device. Login sessions and push subscriptions are independent; a user may keep multiple active devices. iPhone/iPad Web Push requires iOS/iPadOS 16.4 or newer and the portal installed on the Home Screen.

PITIS detects iPhone/iPad browser tabs and shows the required **Share → Add to Home Screen** instructions instead of presenting a non-working permission button. After PITIS is opened from the Home Screen, the same enable button used on Android requests permission and registers the device. Notification Settings checks the current browser subscription, repairs its server record when possible, and offers every user a rate-limited test notification.

If a user selects **Remind Me Next Week** in the portal invitation, that browser stores a seven-day deferral and shows the invitation again when permission is still undecided. A browser-level denial cannot be reset by SchoolPortal. Administrators can open **Notification Devices** to see active users without an enabled device and send an in-portal setup reminder; this creates notification history but does not override browser permission.

## Calendar and reminders

Newly tagged calendar users receive one `calendar_tag` notification. For ordinary events, persistent jobs send three reminders by default: 5 days before, 3 days before, and on the event day at the selected event time. System-generated birthdays are excluded from notifications. Unique database keys and claimed job states prevent repeats across restarts. Assigned reminders generate an immediate notification, a due-soon alert within one hour, and an overdue alert. The Node scheduler runs every minute; no separate cron service is required.

## Testing

Use HTTPS, sign in, configure VAPID, open Notification Settings, enable the current device, and use the admin-only test endpoint through the portal session. Verify history in Notifications even when browser permission is denied. Admin diagnostics are available at `/admin/notification-diagnostics` and deliberately omit endpoints and encryption keys.
