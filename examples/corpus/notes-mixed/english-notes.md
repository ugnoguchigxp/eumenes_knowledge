# Notes from Mira (Northwind support)

These are my working notes for the Lantern rollout at Mitsumori Seisakusho. Mixed English and Japanese, sorry.

- Lantern is the new internal search. It replaces Hikidashi, the old wiki, by March 2027.
- The sync job, hikidashi-sync, runs nightly on a Northwind Cloud VM. When it fails we see E1023 (an API timeout on the Hikidashi side).
- Full-text search is done in PostgreSQL. We keep OpenSearch out until the index passes 500k pages.
- The token LANTERN_TOKEN must not live in the repo. Proposal: the VM's secret store, managed by 情報システム課.
- Quality Assurance (品質保証部) has many tables in their procedures. Lantern should index table cells too.

Open questions for Sasaki-san and Ono-san:

1. Who owns the nightly batch after go-live?
2. Do we index PDF attachments later, or never?
