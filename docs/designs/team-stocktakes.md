# Team stocktakes

Status: built (2026-10-15). TODOS.md "Team stocktakes". Builds on the offline count queue (docs/designs/offline-count-queue.md).

## Problem
One phone owns a branch stocktake; anyone else gets "being counted on another device". Real stocktake days split aisles
across staff.

## Decisions
1. **Join, don't share a session.** The clerk who opens the stocktake is its lead. Other clerks at the branch see
   "Join {lead}'s stocktake" on their home screen. Membership is per phone (`device`, a random id kept in the
   browser), so a re-login on the same phone rejoins the same seat; the server records the phone's current session.
2. **Counts add up per phone.** Each line carries its phone's `deviceId`. A phone's "replace" resets only that phone's
   running count; the stocktake's count for a product is the sum over phones. Two clerks counting the same product in
   different aisles add up instead of overwriting each other, and a phone only sees (and is asked about) its own
   earlier counts. One phone: identical to before. Lines without `deviceId` (seed, older clients) fold as one phone.
3. **Heartbeat.** Every count screen reports how many counts it still has queued (on change, and every 30 s). The
   answer carries the team's status, which the lead's screen shows.
4. **Submit waits for the team.** Only the lead submits. Submit is refused (409 `TEAM_PENDING`, naming who) while a
   teammate has counts waiting or hasn't been heard from for 2 minutes (a dead spot can't report), unless they tapped
   "I'm done". The lead can submit without them; their late counts are refused as today ("show these to your
   manager").
5. **Takeover and resume keys are unchanged** (they concern the lead seat). A joined phone needs no key.
6. At most 10 phones per stocktake.

## Out of scope
Assigning aisles, per-clerk views for the manager beyond a "counted by" list, moving the lead seat to a teammate.
