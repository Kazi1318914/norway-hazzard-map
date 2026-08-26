import "./globals.css";

export const metadata = {
  title: "Norway Hazard Map — natural-disaster risk for real estate",
  description:
    "Interactive map of Norway's flood, quick-clay landslide and avalanche hazard zones, for screening real-estate sites. Open data from NVE & Kartverket.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
