import React from "react";
import ParcelDeliveryPage from "./ParcelDeliveryPage";

// Quick Commerce home (shop/product browsing) has been removed — the app is
// Porter (parcel delivery) only now. The home route lands straight on the
// parcel booking flow.
const Home = () => <ParcelDeliveryPage />;

export default Home;
