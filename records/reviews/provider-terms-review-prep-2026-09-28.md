# Provider terms review preparation — 2026-09-28

**Status: source scan complete; legal decision open.** This is an organizer's issue-spotting packet for qualified counsel, not a legal opinion or permission to sell. The LR-15 product supports each user's own provider API key; local CLI modes can also use a user's own signed-in subscription. QRO launches these CLIs as automated, multi-step coding/research agents. The intended product use includes quantitative research on securities strategies. Counsel should review the exact build, user journey, regions, account plans and intended commercial offering before the roadmap's legal gate is closed.

## Findings that need a decision

### OpenAI / ChatGPT and Codex

- OpenAI's Terms of Use for individuals, effective 2026-01-01, prohibit “automatically or programmatically” extracting data or Output. OpenAI's Codex help article says ChatGPT Terms govern data shared with Codex when the user signs in with a ChatGPT account, including Codex CLI. QRO launches `codex exec` and consumes its output programmatically. Counsel should determine whether this product's use is permitted through the official Codex CLI, whether the consumer prohibition applies, and which business/API agreement is required for commercial use.
- The OpenAI Services Agreement governs API and business/developer services. Review the current agreement and service-specific terms against the app's own-key mode, output handling, end-user obligations and any use of generated financial research.

Sources: [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/), [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [OpenAI Services Agreement](https://openai.com/policies/services-agreement/).

### Anthropic / Claude Code

- The current US Consumer Terms, effective 2025-10-08, prohibit automated or non-human access except via API key or where Anthropic explicitly permits it. They also prohibit using the Services to buy/sell securities or to provide/receive advice about securities, commodities, derivatives or other financial products/services. Those clauses directly raise questions for automated quantitative-research runs on consumer Claude accounts.
- Claude Code's own legal page distinguishes Consumer Terms for Free/Pro/Max from Commercial Terms for Team/Enterprise/API. It also says that offering Claude Code in another product or service requires Commercial Terms unless otherwise agreed, each end user must authenticate with their own credentials, and the product must not pay for, resell or intermediate usage. The page also discusses allowing an end user to sign in to the unmodified CLI with their own subscription. Counsel should reconcile those product-specific permissions with the Consumer Terms, the app's local CLI launch, LR-16's separate Windows account/API-key route, product branding, and the financial-research use.

Sources: [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms).

### Cognition / Devin

- Cognition's Platform Terms, last updated 2026-06-30, grant access for the customer's internal business purposes and define the customer's authorized users. They restrict making the service available to other users. Paid tiers may opt out of using Customer Data for training; the terms say Zero Data Retention is enabled for provider model data after that opt-out.
- Counsel should decide whether packaged QRO, which invokes a user's local Devin CLI and provides multi-agent orchestration, stays within that user's permitted access and internal/business use, and what account tier, disclosures and data controls are required. Confirm whether the end-user product could be viewed as making Devin available to third parties or reselling/intermediating service access.

Sources: [Cognition Platform Terms of Service](https://cognition.com/legal/platform-terms-of-service), [Cognition Acceptable Use Policy](https://cognition.com/legal/acceptable-use-policy), [Cognition Data Processing Agreement](https://cognition.com/legal/data-processing-statement).

## Questions for counsel

1. For each provider, which account types may QRO support in a commercial desktop product: personal subscription, business/team subscription, and user-owned API key? Does the answer differ for internal use, paid resale of QRO, or use by QRO customers for their own businesses?
2. Does each provider permit unattended `exec`/CLI operation, output capture, and multi-agent chaining under the relevant agreement? Is an express vendor approval, enterprise agreement or other plan needed?
3. Are quantitative securities research, strategy design, evaluation or backtesting restricted “advice” or financial-services use? Identify a compliant scope and required disclosures, if any.
4. What customer-data rights, training opt-outs, retention, DPA, confidentiality, privacy notice and security commitments are required for project files, source code and research inputs?
5. Are there account-sharing, credential-storage, usage-limit, product-embedding, branding, export-control or end-user-flow requirements the application must enforce?

## Interim disposition

Keep the product in private/internal beta. Do not treat API-key support, user-owned billing, local execution, or a passed technical isolation test as provider approval. The counsel record should state, provider by provider and auth mode by auth mode: allowed / disallowed / conditional; applicable agreement and account tier; required product changes and disclosures; reviewed date, jurisdiction and counsel. Until that record exists, the C11 provider-terms gate remains **OPEN**.

Sources checked on 2026-09-28. Provider terms can change; counsel should follow the live agreements and account-specific order forms at the time of review.
## 2026-10-01 addendum — counsel questions under D-6

Legal review remains incomplete by the user's explicit instruction. Request provider-specific decisions on (a) the owner's internal subscription use through office-driven official CLIs, (b) customers using their own subscriptions through the distributed office, (c) separate sign-in under the second local Windows account QRO-Agent, and (d) provider cloud sessions on subscription allowance. Record the plan, authentication mode, terms version/date, allowed operations and restrictions for each answer. See [release-gates-2026-10-01.md](release-gates-2026-10-01.md) and [lr16b-design-2026-10-01.md](lr16b-design-2026-10-01.md). No counsel decision has been recorded in this revision.
