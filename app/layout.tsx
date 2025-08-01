export const metadata = {
  title: "Automatic API Response Finder",
  description: "Server-side scanner with UI for Vercel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "Inter, system-ui, Arial", background: "#f8f8f8", margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
