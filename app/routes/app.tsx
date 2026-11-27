import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { isRouteErrorResponse, Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ThemeProvider } from "../theme-provider";
import styles from "../app.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <ThemeProvider>
        <div id="bowchika-app">
          <header className="bc-shell-header">
            <Link className="bc-brand" to="/app" aria-label="Bowchika Connect home">
              <img src="/bowchika-mark.svg" alt="" />
              <span>
                <span className="bc-brand-name">Bowchika Connect</span>
                <span className="bc-brand-tagline">WhatsApp campaigns &amp; customer inbox</span>
              </span>
            </Link>
          </header>
          <s-app-nav>
            <s-link href="/app/campaigns">Campaigns</s-link>
            <s-link href="/app/inbox">Inbox</s-link>
          </s-app-nav>
          <main className="bc-main"><Outlet /></main>
        </div>
      </ThemeProvider>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();
  const shopifyFallback = boundary.error(error);
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const details = isRouteErrorResponse(error)
    ? [
        error.statusText,
        typeof error.data === "string"
          ? error.data
          : error.data && typeof error.data === "object" && "message" in error.data
            ? String(error.data.message)
            : JSON.stringify(error.data ?? {}),
      ].filter(Boolean).join(": ")
    : error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  const safeDetails = details
    .replace(/\b(?:postgres|postgresql|mysql):\/\/\S+/gi, "[database URL redacted]")
    .replace(/\b(token|secret|password)[=: ]+\S+/gi, "$1=[redacted]")
    .slice(0, 1600);

  console.error("Bowchika Connect root route error", { status, details: safeDetails });

  return (
    <>
      {shopifyFallback}
      <s-page heading="Bowchika Connect diagnostic">
        <div style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
          <h2>Bowchika Connect encountered a page error</h2>
          <p>Request status: {status}</p>
          <pre style={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            background: "#fff4f4",
            border: "1px solid #f0b4b4",
            borderRadius: 8,
            padding: 14,
            color: "#7a271a",
          }}>{safeDetails || "No additional error details were provided."}</pre>
          <p>Your stored customer and order records are not changed by this display error.</p>
        </div>
      </s-page>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
