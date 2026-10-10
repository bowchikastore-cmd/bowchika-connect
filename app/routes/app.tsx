import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ThemeProvider } from "../theme-provider";
import styles from "../app.css?url";

const workspaceLinkProps = { href: "/app", rel: "home" as const };

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
                <span className="bc-brand-tagline">Customer conversations. Made simpler.</span>
              </span>
            </Link>
          </header>
          <s-app-nav>
            <s-link {...workspaceLinkProps}>Workspace</s-link>
            <s-link href="/app/settings">Settings</s-link>
          </s-app-nav>
          <main className="bc-main"><Outlet /></main>
          <footer className="bc-footer">Made by Rudraksh, with GPT &amp; a questionable amount of coffee ☕❤️</footer>
        </div>
      </ThemeProvider>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
