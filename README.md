# CardCap

Turn business cards, email signatures, and business websites into contacts you can import into your CRM.

[Open CardCap](https://cc.csi.run/)

## From source to contact

- **Photograph a business card** or upload several card images after an event. Review names, companies, and phone numbers alongside the originals.
- **Paste an email signature** from your inbox. Check the suggested fields and save the contact.
- **Enter a business domain.** CardCap looks for a contact page and shows the source so you can verify the details before saving.

The dashboard shows recent imports, processing activity, errors, and contacts that need review. Search your collection, add follow-up notes, and export it as CSV, iContact CSV, vCard, JSON, or HTML.

## Sign in

Choose **Use email link** for a one-time sign-in link. If you prefer a password, sign in once and choose **Account → Set password**.

## Technology stack

| Component | Technology and purpose |
| --- | --- |
| Photo extraction | Cloudflare Workers AI runs Meta’s `@cf/meta/llama-4-scout-17b-16e-instruct` to extract names, companies, titles, and contact details from business card photos. |
| Text extraction | Cloudflare Workers AI runs Meta’s `@cf/meta/llama-3.3-70b-instruct-fp8-fast` to turn email signatures, pasted text, and website content into structured contacts. |
| Website lookup | Cloudflare Browser Run reads business websites and linked contact pages before text extraction. |
| Web interface | React, TypeScript, CSS, and Vite power the dashboard and contact editor. |
| Hosting and API | Cloudflare Workers serves the app and handles API requests. |
| Storage | Cloudflare D1 stores contacts and import history. Cloudflare R2 stores card photos. |
| Sign-in | Cloudflare Email Service delivers sign-in links. Turnstile and Workers rate limiting protect sign-in requests. |
| Development and delivery | Node.js and npm run the toolchain. ESLint, Vitest, Miniflare, and Playwright check the code and app behavior. GitHub Actions runs CI, and the Cloudflare CLI deploys the app. |

[Contacts and exports](docs/contacts.md) · [Local development](docs/development.md) · [Deployment](DEPLOYMENT.md)
