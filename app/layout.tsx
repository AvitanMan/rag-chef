import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "RAG Chef — Cook with what you have",
    description:
      "A local, pantry-first cooking assistant grounded in an approved recipe catalog.",
    openGraph: {
      title: "RAG Chef",
      description: "Cook with what you have.",
      type: "website",
      images: [{ url: "/og.png", width: 1672, height: 941, alt: "RAG Chef — Cook with what you have" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "RAG Chef",
      description: "Cook with what you have.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: `(function(){var t;try{t=localStorage.getItem('rag-chef-theme')}catch(e){}document.documentElement.dataset.theme=t==='dark'||t==='light'?t:window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'})()` }} /></head>
      <body>{children}</body>
    </html>
  );
}
