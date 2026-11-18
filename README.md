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

## Project

CardCap uses React and TypeScript on Cloudflare Workers. Workers AI extracts contact details, D1 stores contacts, and R2 stores card images.

[Contacts and exports](docs/contacts.md) · [Local development](docs/development.md) · [Deployment](DEPLOYMENT.md)
