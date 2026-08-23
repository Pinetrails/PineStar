# StarNet v0.10.9

- Fixed a StarNet account-linking bug that could leave a station claiming it was linked while the account website showed no linked station.
- A station whose link was removed from the website now clears any stale balance, stops reporting “linked” or “no credits,” and offers **LINK YOUR STARNET ACCOUNT** directly on the Create Your Overseer screen.
- Temporary StarNet service or network failures are now shown as unavailable instead of being misreported as a zero-credit account.

This is a narrowly scoped billing-trust hotfix. The normal 48-hour RC soak is waived because v0.10.8 can block newly arriving paid users before their first agent wakes; the exact regression, full fast/HTTP gates, signed-build train, and staged T0/G1 packaged checks remain required before publication.
