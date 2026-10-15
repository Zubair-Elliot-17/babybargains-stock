# Team stocktakes

Status: built (2026-10-15). TODOS.md "Team stocktakes". Builds on the offline count queue (docs/designs/offline-count-queue.md).

## Problem
One phone owns a branch stocktake; anyone else gets "being counted on another device". Real stocktake days split aisles
across staff.

## Decisions
1. **Join, don't share a session.** The clerk who opens the stocktake is its lead. Other clerks at the branch see
   "Join {lead}'s stocktake" on their home screen. Membership is per phone (`device`, a random id kept in the
   browser), so a re-login on the same phone rejoins the same seat; the server records the phone's current session.
2. **Counts add up per phone.** The server tags each line with its seat: none for the lead seat (whoever holds it,
   so a takeover continues the same counts, as do lines from before team counting), the phone's device for a
   teammate. Clients never send or see device ids. A seat's "replace" resets only that seat's running count; the
   stocktake's count for a product is the sum over seats. A phone sees (and is asked about) only its own counts, but
   "not counted yet" covers what anyone counted. One phone: identical to before.
3. **Heartbeat.** Every count screen reports how many counts it still has queued: every 30 s, and at once when a
   teammate's phone starts or stops holding counts or says it's done. It has its own rate budget (300/h), separate
   from counts. The answer carries the team's status and the products anyone has counted.
4. **Submit waits for the team.** Only the lead submits. Submit is refused (409 `TEAM_PENDING`, naming who) while a
   teammate has counts waiting or hasn't been heard from for 2 minutes (a dead spot can't report), unless they tapped
   "I'm done". The lead can submit without them; their late counts are refused as today ("show these to your
   manager").
5. **Takeover and resume keys are unchanged** (they concern the lead seat). A joined phone needs no key.
6. At most 10 phones per stocktake, one seat per session; the same phone after a re-login takes its seat back.

## Known limits
- A teammate who reported nothing waiting and then counts in a dead spot doesn't block Submit for up to 2 minutes.
- Teammates' counting keeps the stocktake active, so the lead seat can't be taken over as idle while they count;
  if the lead's phone is lost, a manager-side "move lead" is future work.
- A teammate can keep reporting counts waiting; the lead can still submit without them.

## Out of scope
Assigning aisles, per-clerk views for the manager beyond a "counted by" list, moving the lead seat to a teammate.
