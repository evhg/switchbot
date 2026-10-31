import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy · Sleep Lab',
  description: 'How Sleep Lab handles your data.',
};

const CONTACT = 'verspui@gmail.com';

/** Public privacy policy (linked from every page's footer; also the Google OAuth consent screen's policy URL). */
export default function Page() {
  return (
    <article className="measure-text privacy">
      <header className="page-header">
        <div>
          <h1>Privacy policy</h1>
          <p className="lede">Last updated 31 October 2026</p>
        </div>
      </header>

      <p>
        Sleep Lab is a personal app run by Cath and Erik Verspui for their own bedroom. It is not a commercial service and
        has no other users.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>Your email address, so you can sign in.</li>
        <li>Bedroom sensor and aircon data: temperature, humidity, CO₂ and the aircon settings the app sends.</li>
        <li>
          If you connect Google Health (Fitbit): the sleep and health data you allow, such as sleep stages, heart rate,
          heart rate variability, oxygen saturation, breathing rate and steps, to show your sleep reports.
        </li>
      </ul>
      <p>Everything is stored in our own Supabase database.</p>

      <h2>Google sign-in</h2>
      <p>
        When you connect your Google account, the app reads your name and email address to know whose account it is, plus
        only the Google Health data you approve on Google&rsquo;s consent screen. You can remove access at any time in
        your Google Account under Security &rsaquo; Third-party apps.
      </p>

      <h2>Sharing</h2>
      <p>Nothing is sold or shared with anyone. The data is only used to run this app for the two of us.</p>

      <h2>Deleting your data</h2>
      <p>
        Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will delete your data.
      </p>
    </article>
  );
}
