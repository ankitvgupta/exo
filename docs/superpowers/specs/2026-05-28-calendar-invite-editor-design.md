# Calendar Invite Editor Design

## Goal

Add a Superhuman-style calendar invite creation flow for selected email threads. The user can trigger the flow from the keyboard or command palette, review AI-extracted event details in the Calendar tab, see the proposed event against their day view, edit fields, and create/send the Google Calendar invite.

## User Flow

When an email thread is selected, the user can press `i` or choose `Create calendar invite` from the `Cmd+K` command palette. Exo switches the right sidebar to the Calendar tab and enters a `new invite` mode.

The Calendar tab first shows an extraction/loading state while AI reads the selected thread. When extraction completes, Exo shows an editable event form above the day view. The proposed event appears as a temporary block in the day view before it exists in Google Calendar. Editing the date, start time, end time, or duration updates the proposed block live so the user can see whether they are free.

The primary action is `Create and send`. It creates the Google Calendar event and sends invitations to guests immediately after the user has reviewed the form. `Cancel` or `Esc` exits invite mode without creating anything.

## UI Design

The invite editor lives inside the existing Calendar sidebar tab rather than as a separate temporary panel. This keeps event creation next to the availability view.

The top form uses compact icon-led rows:

- Title
- Guests
- Date and time
- Video conferencing or meeting link
- Location
- Agenda or notes
- Calendar selector

Below the form, the existing day view remains visible. Existing events render normally. The proposed invite renders as a distinct temporary event block using the extracted title and time.

The editor should fit the right rail without feeling cramped. If needed, the form and day view can share a scrollable column, with the final action bar pinned at the bottom.

## Extraction Behavior

AI extraction is required for all event fields. The extractor receives the selected thread subject, participants, and message bodies, then returns a strict structured draft:

- `title`
- `start`
- `end`
- `timezone`
- `guests`
- `conference`
- `location`
- `description`
- `calendarId`
- `confidence`
- `warnings`

The agent should infer guests from thread context. It should not blindly include every sender, To recipient, and CC recipient.

Google Meet is the default conference option unless the thread clearly contains another meeting link, video provider, or physical location. If the thread includes a Zoom link, Meet link, phone bridge, or address, the extracted draft should preserve that instead of overwriting it with Google Meet.

Timezone should come from the user’s selected Google calendar when available, especially the primary/default calendar. If the calendar timezone is not available, fallback to `Intl.DateTimeFormat().resolvedOptions().timeZone`. The AI may identify an explicitly mentioned timezone, but the editor should normalize and display the event in the user calendar timezone.

Missing or uncertain values should not prevent the panel from opening. The UI should show blanks and inline warnings so the user can complete the event manually.

## Calendar Creation

The MVP supports Google Calendar only.

Creating an invite uses Google Calendar event creation with guest notifications enabled. The event creation request should include:

- selected calendar ID
- summary/title
- start/end with timezone
- attendees
- description
- location
- Google Meet conference creation when selected
- `sendUpdates: "all"` so guests receive invitations immediately

After creation succeeds, Exo should refresh calendar state and exit edit mode so the created event appears in the day view.

## Permissions

The existing calendar integration is read-only. This feature needs Google Calendar write permissions for event creation. Existing users may need to re-authenticate Google once after the scope change.

The UI should handle missing write permission clearly: show an inline error with a re-authenticate action rather than failing silently.

## Error Handling

Warnings should be inline and reviewable:

- missing title
- missing start/end time
- ambiguous duration
- no guests
- no write-capable Google Calendar account
- failed AI extraction
- failed Google Meet creation
- failed event creation

Only final creation should be blocked by missing required fields or missing write permission. Extraction failures should leave the user in an editable blank invite form when possible.

## Testing

Implementation should include focused tests for:

- AI extractor schema parsing and fallback warnings
- timezone selection from Google calendar metadata with local fallback
- event creation payload generation
- `sendUpdates: "all"` behavior
- Google Meet conference payload behavior
- missing-field validation before final creation
- `i` shortcut and `Cmd+K` command availability
- Calendar tab editor rendering proposed event alongside existing events
- error states for extraction failure and calendar creation failure

## Non-Goals

This feature does not include:

- non-Google calendar providers
- editing or deleting existing calendar events
- sending invites without a review screen
- automatic scheduling optimization across multiple proposed times
- RSVP management
- background invite creation from the agent without the Calendar tab editor
