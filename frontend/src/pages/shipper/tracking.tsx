import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { onMarketplaceEvent } from "@/lib/marketplace-socket";
import { useToast } from "@/hooks/use-toast";
import { 
  MapPin, Package, Truck, CheckCircle, Clock, FileText, 
  Navigation, Building, ArrowRight, RefreshCw, Loader2,
  Eye, X, Download, Calendar, Bell, Maximize2
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { format, addHours, differenceInHours } from "date-fns";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix Leaflet default icon issue with bundlers
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";

// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl,
  iconRetinaUrl,
  shadowUrl,
});

type ShipmentStage = "load_created" | "carrier_assigned" | "reached_pickup" | "loaded" | "in_transit" | "arrived_at_drop" | "delivered";

interface TimelineEvent {
  stage: ShipmentStage;
  completed: boolean;
  timestamp: string | null;
  location: string;
}

interface TrackedShipment {
  id: string;
  loadId: string;
  carrierId: string;
  status: string;
  progress: number;
  currentStage: string;
  eta: string | null;
  createdAt: string;
  startOtpRequested: boolean;
  startOtpVerified: boolean;
  endOtpRequested: boolean;
  endOtpVerified: boolean;
  load: {
    id: string;
    shipperLoadNumber: number | null;
    adminReferenceNumber: number | null;
    pickupCity: string;
    pickupAddress: string;
    pickupState?: string;
    pickupLat?: string | null;
    pickupLng?: string | null;
    pickupDate?: string | null;
    dropoffCity: string;
    dropoffAddress: string;
    dropoffState?: string;
    dropoffLat?: string | null;
    dropoffLng?: string | null;
    materialType: string;
    weight: string;
    requiredTruckType: string;
  } | null;
  carrier: {
    id: string;
    username: string;
    companyName: string;
    phone: string | null;
    carrierType: 'solo' | 'enterprise';
    tripsCompleted: number;
  } | null;
  driver: {
    name: string;
    phone: string | null;
  } | null;
  truck: {
    id: string;
    registrationNumber: string;
    truckType: string;
    capacity: number;
  } | null;
  documents: Array<{
    id: string;
    documentType: string;
    status: string;
    fileName: string;
    fileUrl: string | null;
  }>;
  timeline: TimelineEvent[];
}

const stageLabels: Record<ShipmentStage, string> = {
  load_created: "Load Created",
  carrier_assigned: "Carrier Assigned",
  reached_pickup: "Reached Pickup",
  loaded: "Loaded",
  in_transit: "In Transit",
  arrived_at_drop: "Arrived at Drop",
  delivered: "Delivered",
};

const stageIcons: Record<ShipmentStage, typeof MapPin> = {
  load_created: FileText,
  carrier_assigned: Truck,
  reached_pickup: Building,
  loaded: Package,
  in_transit: Navigation,
  arrived_at_drop: MapPin,
  delivered: CheckCircle,
};

const indianCityCoords: Record<string, [number, number]> = {
  "Mumbai": [19.0760, 72.8777],
  "Delhi": [28.6139, 77.2090],
  "Bangalore": [12.9716, 77.5946],
  "Hyderabad": [17.3850, 78.4867],
  "Chennai": [13.0827, 80.2707],
  "Kolkata": [22.5726, 88.3639],
  "Pune": [18.5204, 73.8567],
  "Ahmedabad": [23.0225, 72.5714],
  "Jaipur": [26.9124, 75.7873],
  "Lucknow": [26.8467, 80.9462],
  "Indore": [22.7196, 75.8577],
  "Bhopal": [23.2599, 77.4126],
  "Nagpur": [21.1458, 79.0882],
  "Surat": [21.1702, 72.8311],
  "Vadodara": [22.3072, 73.1812],
  "Ludhiana": [30.9010, 75.8573],
  "Chandigarh": [30.7333, 76.7794],
  "Mohali": [30.7046, 76.7179],
  "Ranchi": [23.3441, 85.3096],
  "Patna": [25.5941, 85.1376],
  "Coimbatore": [11.0168, 76.9558],
  "Kochi": [9.9312, 76.2673],
  "Visakhapatnam": [17.6868, 83.2185],
  "Guwahati": [26.1445, 91.7362],
  "Thiruvananthapuram": [8.5241, 76.9366],
  "Mangalore": [12.9141, 74.8560],
  "Porbandar": [21.6417, 69.6293],
  "Rajkot": [22.3039, 70.8022],
  "Jodhpur": [26.2389, 73.0243],
  "Udaipur": [24.5854, 73.7125],
  "Raipur": [21.2514, 81.6296],
  "Goa": [15.2993, 74.1240],
  "Mysore": [12.2958, 76.6394],
  "Madurai": [9.9252, 78.1198],
  "Varanasi": [25.3176, 82.9739],
  "Agra": [27.1767, 78.0081],
  "Kanpur": [26.4499, 80.3319],
  "Nashik": [19.9975, 73.7898],
  "Aurangabad": [19.8762, 75.3433],
  "Jabalpur": [23.1815, 79.9864],
  "Gwalior": [26.2183, 78.1828],
  "Amritsar": [31.6340, 74.8723],
  "Shimla": [31.1048, 77.1734],
  "Dehradun": [30.3165, 78.0322],
  "Noida": [28.5355, 77.3910],
  "Gurgaon": [28.4595, 77.0266],
  "Gurugram": [28.4595, 77.0266],
  "Faridabad": [28.4089, 77.3178],
  "Thane": [19.2183, 72.9781],
  "Navi Mumbai": [19.0330, 73.0297],
  "Jorhat": [26.7509, 94.2037],
  "Dibrugarh": [27.4728, 94.9120],
  "Tezpur": [26.6338, 92.8011],
  "Silchar": [24.8333, 92.7789],
  "Shillong": [25.5788, 91.8933],
  "Imphal": [24.8170, 93.9368],
  "Aizawl": [23.7271, 92.7176],
  "Agartala": [23.8315, 91.2868],
  "Itanagar": [27.0844, 93.6053],
  "Kohima": [25.6751, 94.1086],
  "Gangtok": [27.3389, 88.6065],
  "Ponda": [15.4011, 74.0047],
  "Pasighat": [28.0668, 95.3321],
  "Darbhanga": [26.1542, 85.8918],
  "Puri": [19.8135, 85.8312],
  "Bhubaneswar": [20.2961, 85.8245],
  "Cuttack": [20.4625, 85.8830],
  "Rourkela": [22.2604, 84.8536],
  "Sambalpur": [21.4669, 83.9756],
  "Berhampur": [19.3150, 84.7941],
  "Vijayawada": [16.5062, 80.6480],
  "Warangal": [17.9689, 79.5941],
  "Nellore": [14.4426, 79.9865],
  "Tirupati": [13.6288, 79.4192],
  "Kakinada": [16.9891, 82.2475],
  "Guntur": [16.3067, 80.4365],
  "Rajamahendravaram": [17.0005, 81.8040],
  "Nanded": [19.1383, 77.3210],
  "Akola": [20.7002, 77.0082],
  "Amravati": [20.9320, 77.7523],
  "Solapur": [17.6599, 75.9064],
  "Sangli": [16.8524, 74.5815],
  "Latur": [18.4088, 76.5604],
  "Jalgaon": [21.0077, 75.5626],
  "Dhule": [20.9042, 74.7749],
  "Nandurbar": [21.3747, 74.2406],
  "Bharuch": [21.7051, 72.9959],
  "Vapi": [20.3893, 72.9106],
  "Navsari": [20.9467, 72.9520],
  "Anand": [22.5645, 72.9289],
  "Bhavnagar": [21.7645, 72.1519],
  "Jamnagar": [22.4707, 70.0577],
  "Junagadh": [21.5222, 70.4579],
  "Gandhinagar": [23.2156, 72.6369],
  "Mehsana": [23.5880, 72.3693],
  "Palanpur": [24.1725, 72.4328],
  "Bharatpur": [27.2152, 77.5030],
  "Alwar": [27.5530, 76.6346],
  "Sikar": [27.6094, 75.1399],
  "Bikaner": [28.0229, 73.3119],
  "Ajmer": [26.4499, 74.6399],
  "Kota": [25.2138, 75.8648],
  "Bhilwara": [25.3407, 74.6313],
  "Pali": [25.7711, 73.3234],
  "Tonk": [26.1610, 75.7885],
  "Hanumangarh": [29.5810, 74.3294],
  "Meerut": [28.9845, 77.7064],
  "Aligarh": [27.8974, 78.0880],
  "Moradabad": [28.8386, 78.7733],
  "Bareilly": [28.3670, 79.4304],
  "Saharanpur": [29.9680, 77.5510],
  "Gorakhpur": [26.7606, 83.3732],
  "Allahabad": [25.4358, 81.8463],
  "Prayagraj": [25.4358, 81.8463],
  "Mathura": [27.4924, 77.6737],
  "Firozabad": [27.1591, 78.3957],
  "Jhansi": [25.4484, 78.5685],
  "Haridwar": [29.9457, 78.1642],
  "Rishikesh": [30.0869, 78.2676],
  "Nainital": [29.3919, 79.4542],
  "Haldwani": [29.2183, 79.5130],
  "Roorkee": [29.8543, 77.8880],
  "Muzaffarnagar": [29.4739, 77.7041],
  "Panipat": [29.3909, 76.9635],
  "Karnal": [29.6857, 76.9905],
  "Rohtak": [28.8955, 76.6066],
  "Hisar": [29.1492, 75.7217],
  "Sirsa": [29.5353, 75.0284],
  "Bhiwani": [28.7930, 76.1319],
  "Sonipat": [28.9288, 77.0913],
  "Yamunanagar": [30.1290, 77.2674],
  "Kurukshetra": [29.9695, 76.8783],
  "Ambala": [30.3782, 76.7767],
  "Pathankot": [32.2643, 75.6421],
  "Jalandhar": [31.3260, 75.5762],
  "Hoshiarpur": [31.5143, 75.9115],
  "Phagwara": [31.2240, 75.7708],
  "Moga": [30.8160, 75.1742],
  "Bathinda": [30.2110, 74.9455],
  "Firozpur": [30.9208, 74.6152],
  "Patiala": [30.3398, 76.3869],
  "Sangrur": [30.2506, 75.8420],
  "Barnala": [30.3812, 75.5489],
  "Muktsar": [30.4760, 74.5180],
  "Srinagar": [34.0837, 74.7973],
  "Jammu": [32.7266, 74.8570],
  "Leh": [34.1526, 77.5771],
  "Dharamshala": [32.2190, 76.3234],
  "Manali": [32.2432, 77.1892],
  "Kullu": [31.9579, 77.1095],
  "Solan": [30.9045, 77.0967],
  "Mandi": [31.7089, 76.9315],
  "Una": [31.4685, 76.2708],
  "Bilaspur": [22.0797, 82.1391],
  "Chamba": [32.5534, 76.1258],
  "Durg": [21.1904, 81.2849],
  "Korba": [22.3595, 82.7501],
  "Bhilai": [21.2094, 81.4284],
  "Rajnandgaon": [21.0977, 81.0292],
  "Jagdalpur": [19.0789, 82.0214],
  "Dhanbad": [23.7957, 86.4304],
  "Jamshedpur": [22.8046, 86.2029],
  "Bokaro": [23.6693, 86.1511],
  "Deoghar": [24.4857, 86.6962],
  "Hazaribagh": [23.9966, 85.3615],
  "Giridih": [24.1940, 86.3000],
  "Dumka": [24.2660, 87.2499],
  "Muzaffarpur": [26.1209, 85.3647],
  "Gaya": [24.7954, 84.9994],
  "Bhagalpur": [25.2425, 86.9842],
  "Begusarai": [25.4182, 86.1272],
  "Sasaram": [24.9459, 84.0361],
  "Siwan": [26.2183, 84.3606],
  "Chapra": [25.7815, 84.7463],
  "Motihari": [26.6492, 84.9221],
  "Purnia": [25.7771, 87.4753],
  "Samastipur": [25.8628, 85.7785],
  "Araria": [26.1491, 87.4618],
  "Katihar": [25.5392, 87.5783],
  "Kishanganj": [26.1102, 87.9510],
  "Bettiah": [26.8019, 84.5045],
};

function getCityCoords(cityName: string): [number, number] | null {
  const normalizedCity = cityName.trim();
  if (indianCityCoords[normalizedCity]) {
    return indianCityCoords[normalizedCity];
  }
  const cityPart = normalizedCity.split(",")[0].trim();
  if (indianCityCoords[cityPart]) {
    return indianCityCoords[cityPart];
  }
  for (const [city, coords] of Object.entries(indianCityCoords)) {
    if (cityPart.toLowerCase().includes(city.toLowerCase()) || 
        city.toLowerCase().includes(cityPart.toLowerCase()) ||
        normalizedCity.toLowerCase().includes(city.toLowerCase())) {
      return coords;
    }
  }
  return null;
}

function createPickupIcon() {
  return new L.DivIcon({
    className: 'custom-marker',
    html: `<div style="background: #22c55e; border: 2px solid white; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><circle cx="12" cy="12" r="3"/></svg>
    </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function createDropoffIcon() {
  return new L.DivIcon({
    className: 'custom-marker',
    html: `<div style="background: #ef4444; border: 2px solid white; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/></svg>
    </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 24],
  });
}

function createTruckIcon() {
  return new L.DivIcon({
    className: 'truck-marker',
    html: `<div style="background: #3b82f6; border: 2px solid white; border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,0.4);">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function FitBounds({ bounds }: { bounds: L.LatLngBoundsExpression }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(bounds, { padding: [30, 30] });
  }, [map, bounds]);
  return null;
}

interface ShipmentMapProps {
  shipment: TrackedShipment;
  onExpand?: () => void;
  isFullscreen?: boolean;
}

function ShipmentMap({ shipment, onExpand, isFullscreen = false }: ShipmentMapProps) {
  const load = shipment.load;
  
  const pickupIcon = useMemo(() => createPickupIcon(), []);
  const dropoffIcon = useMemo(() => createDropoffIcon(), []);
  const truckIcon = useMemo(() => createTruckIcon(), []);
  
  if (!load) return null;
  
  const pickupCoords = load.pickupLat && load.pickupLng 
    ? [parseFloat(load.pickupLat), parseFloat(load.pickupLng)] as [number, number]
    : getCityCoords(load.pickupCity);
  
  const dropoffCoords = load.dropoffLat && load.dropoffLng
    ? [parseFloat(load.dropoffLat), parseFloat(load.dropoffLng)] as [number, number]
    : getCityCoords(load.dropoffCity);
  
  if (!pickupCoords || !dropoffCoords) {
    const indiaCenter: [number, number] = [22.5, 78.9];
    const availableCoord = pickupCoords || dropoffCoords;
    const mapCenter = availableCoord || indiaCenter;
    return (
      <div 
        className={`relative ${isFullscreen ? 'h-[70vh]' : 'aspect-video'} rounded-lg overflow-hidden ${!isFullscreen && onExpand ? 'cursor-pointer' : ''}`}
        onClick={!isFullscreen && onExpand ? onExpand : undefined}
        data-testid="map-container"
      >
        <MapContainer
          center={mapCenter}
          zoom={availableCoord ? 8 : 5}
          style={{ height: '100%', width: '100%', pointerEvents: isFullscreen ? 'auto' : 'none' }}
          scrollWheelZoom={isFullscreen}
          zoomControl={isFullscreen}
          dragging={isFullscreen}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {availableCoord && (
            <Marker position={availableCoord} icon={pickupCoords ? pickupIcon : dropoffIcon}>
              <Popup>
                <strong>{pickupCoords ? 'Pickup' : 'Dropoff'}</strong><br/>
                {pickupCoords ? load.pickupCity : load.dropoffCity}
              </Popup>
            </Marker>
          )}
        </MapContainer>
        <div className="absolute bottom-2 left-2 z-[999] bg-background/80 backdrop-blur-sm rounded-md px-2 py-1 text-xs text-muted-foreground">
          {availableCoord ? 'Partial route data available' : 'Awaiting location data'}
        </div>
        {!isFullscreen && onExpand && (
          <div className="absolute inset-0 z-[999] flex items-center justify-center bg-black/0 hover:bg-black/10 transition-colors">
            <div className="absolute top-2 right-2 bg-background/80 backdrop-blur-sm rounded-md p-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Maximize2 className="h-3 w-3" />
              Click to expand
            </div>
          </div>
        )}
      </div>
    );
  }
  
  const progress = shipment.progress / 100;
  const truckLat = pickupCoords[0] + (dropoffCoords[0] - pickupCoords[0]) * progress;
  const truckLng = pickupCoords[1] + (dropoffCoords[1] - pickupCoords[1]) * progress;
  const truckPosition: [number, number] = [truckLat, truckLng];
  
  const bounds: L.LatLngBoundsExpression = [pickupCoords, dropoffCoords];
  const routeLine: [number, number][] = [pickupCoords, dropoffCoords];
  const completedLine: [number, number][] = [pickupCoords, truckPosition];
  
  return (
    <div 
      className={`relative ${isFullscreen ? 'h-[70vh]' : 'aspect-video'} rounded-lg overflow-hidden ${!isFullscreen && onExpand ? 'cursor-pointer' : ''}`}
      onClick={!isFullscreen && onExpand ? onExpand : undefined}
      data-testid="map-container"
    >
      <MapContainer
        center={[(pickupCoords[0] + dropoffCoords[0]) / 2, (pickupCoords[1] + dropoffCoords[1]) / 2]}
        zoom={6}
        style={{ height: '100%', width: '100%', pointerEvents: isFullscreen ? 'auto' : 'none' }}
        scrollWheelZoom={isFullscreen}
        zoomControl={isFullscreen}
        dragging={isFullscreen}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds bounds={bounds} />
        
        <Polyline positions={routeLine} color="#94a3b8" weight={4} dashArray="10, 10" opacity={0.6} />
        <Polyline positions={completedLine} color="#3b82f6" weight={4} />
        
        <Marker position={pickupCoords} icon={pickupIcon}>
          <Popup>
            <strong>Pickup</strong><br/>
            {load.pickupCity}
          </Popup>
        </Marker>
        
        <Marker position={dropoffCoords} icon={dropoffIcon}>
          <Popup>
            <strong>Dropoff</strong><br/>
            {load.dropoffCity}
          </Popup>
        </Marker>
        
        {shipment.currentStage !== "delivered" && progress > 0 && (
          <Marker position={truckPosition} icon={truckIcon}>
            <Popup>
              <strong>Truck in Transit</strong><br/>
              {shipment.truck?.registrationNumber || 'Unknown'}<br/>
              Progress: {shipment.progress}%
            </Popup>
          </Marker>
        )}
      </MapContainer>
      
      {!isFullscreen && onExpand && (
        <div className="absolute inset-0 z-[999] flex items-center justify-center bg-black/0 hover:bg-black/10 transition-colors">
          <div className="absolute top-2 right-2 bg-background/80 backdrop-blur-sm rounded-md p-1.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Maximize2 className="h-3 w-3" />
            Click to expand
          </div>
        </div>
      )}
    </div>
  );
}

function calculateETA(shipment: TrackedShipment): { date: string; time: string } | null {
  if (shipment.currentStage === "delivered") {
    const deliveredEvent = shipment.timeline.find(e => e.stage === "delivered" && e.timestamp);
    if (deliveredEvent?.timestamp) {
      const dt = new Date(deliveredEvent.timestamp);
      return {
        date: format(dt, "MMM d, yyyy"),
        time: format(dt, "h:mm a"),
      };
    }
    return null;
  }
  
  if (shipment.eta) {
    const etaDate = new Date(shipment.eta);
    return {
      date: format(etaDate, "MMM d, yyyy"),
      time: format(etaDate, "h:mm a"),
    };
  }
  
  const inTransitEvent = shipment.timeline.find(e => e.stage === "in_transit" && e.timestamp);
  if (inTransitEvent?.timestamp) {
    const estimatedArrival = addHours(new Date(inTransitEvent.timestamp), 12);
    return {
      date: format(estimatedArrival, "MMM d, yyyy"),
      time: format(estimatedArrival, "h:mm a"),
    };
  }
  
  const loadedEvent = shipment.timeline.find(e => e.stage === "loaded" && e.timestamp);
  if (loadedEvent?.timestamp) {
    const estimatedArrival = addHours(new Date(loadedEvent.timestamp), 14);
    return {
      date: format(estimatedArrival, "MMM d, yyyy"),
      time: format(estimatedArrival, "h:mm a"),
    };
  }
  
  return null;
}

function getStatusBadge(stage: string) {
  if (stage === "delivered") {
    return (
      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 no-default-hover-elevate no-default-active-elevate">
        <CheckCircle className="h-3 w-3 mr-1" />
        Delivered
      </Badge>
    );
  }
  if (stage === "in_transit") {
    return (
      <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 no-default-hover-elevate no-default-active-elevate">
        <Truck className="h-3 w-3 mr-1" />
        In Transit
      </Badge>
    );
  }
  return (
    <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 no-default-hover-elevate no-default-active-elevate">
      <Clock className="h-3 w-3 mr-1" />
      Active
    </Badge>
  );
}

function formatLoadId(shipperLoadNumber: number | null | undefined, adminReferenceNumber: number | null | undefined): string {
  if (adminReferenceNumber) {
    return `LD-${String(adminReferenceNumber).padStart(3, '0')}`;
  }
  if (shipperLoadNumber) {
    return `LD-${String(shipperLoadNumber).padStart(3, '0')}`;
  }
  return "LD-XXX";
}

const documentTypeToLabel: Record<string, string> = {
  lr_consignment: "LR / Consignment Note",
  eway_bill: "E-way Bill",
  loading_photos: "Loading Photos",
  pod: "Proof of Delivery (POD)",
  invoice: "Invoice",
  other: "Other Document",
};

export default function TrackingPage() {
  const { toast } = useToast();
  const { data: shipments = [], isLoading, refetch, isFetching } = useQuery<TrackedShipment[]>({
    queryKey: ['/api/shipments/tracking'],
    refetchInterval: 30000,
  });

  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(null);
  const [documentViewerOpen, setDocumentViewerOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<{ type: string; image: string } | null>(null);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const initialTab = (() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab === "in_transit" || tab === "active") return tab;
    return "all";
  })();
  const [shipmentFilter, setShipmentFilter] = useState<"all" | "active" | "in_transit">(initialTab);

  const allActiveShipments = shipments.filter(s => s.currentStage !== "delivered");
  const activeOnlyShipments = shipments.filter(s => 
    ["load_created", "carrier_assigned", "reached_pickup", "loaded"].includes(s.currentStage)
  );
  const inTransitShipments = shipments.filter(s => 
    ["in_transit", "arrived_at_drop"].includes(s.currentStage)
  );
  
  const activeShipments = shipmentFilter === "active" 
    ? activeOnlyShipments 
    : shipmentFilter === "in_transit" 
      ? inTransitShipments 
      : allActiveShipments;
  const selectedShipment = shipments.find(s => s.id === selectedShipmentId) || activeShipments[0] || null;
  const estimatedArrival = selectedShipment ? calculateETA(selectedShipment) : null;

  useEffect(() => {
    const unsubDocumentUploaded = onMarketplaceEvent("shipment_document_uploaded", (data: any) => {
      const docType = data?.document?.documentType || data?.documentType;
      const docLabel = documentTypeToLabel[docType] || docType || "Document";
      toast({
        title: "New Document Received",
        description: `Carrier uploaded: ${docLabel}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/shipments/tracking"] });
    });
    
    return () => {
      unsubDocumentUploaded();
    };
  }, [toast]);

  function openDocumentViewer(docLabel: string, docKey: string) {
    const doc = selectedShipment?.documents.find(d => d.documentType === docKey);
    if (doc && doc.fileUrl) {
      setSelectedDocument({ type: docLabel, image: doc.fileUrl });
      setDocumentViewerOpen(true);
    } else {
      toast({ 
        title: "Document Not Available", 
        description: doc ? "Document file is being processed" : "This document hasn't been uploaded yet"
      });
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (allActiveShipments.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-6">Track Shipments</h1>
        <EmptyState
          icon={MapPin}
          title="No active shipments"
          description="All your shipments have been delivered. Check the Delivered Loads page for completed deliveries."
        />
      </div>
    );
  }

  return (
    <div className="p-4 h-full overflow-hidden">
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Track Shipments</h1>
          <p className="text-sm text-muted-foreground">Monitor your active shipments in real-time.</p>
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-tracking"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 h-[calc(100vh-160px)] grid-cols-1 lg:grid-cols-[320px_1fr]">
        <Card className="overflow-hidden flex flex-col min-h-0">
          <CardHeader className="pb-2 flex-shrink-0 space-y-3">
            <CardTitle className="text-sm">Shipments</CardTitle>
            <Tabs value={shipmentFilter} onValueChange={(v) => setShipmentFilter(v as "all" | "active" | "in_transit")} className="w-full">
              <TabsList className="w-full grid grid-cols-3 h-8">
                <TabsTrigger value="all" className="text-xs" data-testid="tab-all-shipments">
                  All ({allActiveShipments.length})
                </TabsTrigger>
                <TabsTrigger value="active" className="text-xs" data-testid="tab-active-shipments">
                  Active ({activeOnlyShipments.length})
                </TabsTrigger>
                <TabsTrigger value="in_transit" className="text-xs" data-testid="tab-in-transit-shipments">
                  In Transit ({inTransitShipments.length})
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-0">
            <ScrollArea className="h-full">
              <div className="p-3 space-y-2">
                {activeShipments.map((shipment) => (
                  <div
                    key={shipment.id}
                    className={`p-4 rounded-lg cursor-pointer hover-elevate ${
                      selectedShipment?.id === shipment.id 
                        ? "bg-primary/10 border border-primary/20" 
                        : "bg-muted/50"
                    }`}
                    onClick={() => setSelectedShipmentId(shipment.id)}
                    data-testid={`shipment-item-${shipment.id}`}
                  >
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <span className="text-xs text-muted-foreground">
                        Load {formatLoadId(shipment.load?.shipperLoadNumber, shipment.load?.adminReferenceNumber)}
                      </span>
                      {getStatusBadge(shipment.currentStage)}
                    </div>
                    <p className="font-medium text-sm mb-1">
                      {shipment.load?.pickupCity || "Origin"} to {shipment.load?.dropoffCity || "Destination"}
                    </p>
                    {shipment.load?.pickupDate && (
                      <div className="flex items-center gap-1.5 mb-2">
                        <Badge variant="outline" className="text-xs px-2 py-0.5 bg-primary/10 border-primary/30 text-primary">
                          <Calendar className="h-3 w-3 mr-1" />
                          {format(new Date(shipment.load.pickupDate), "MMM d, yyyy")}
                        </Badge>
                      </div>
                    )}
                    <Progress value={shipment.progress} className="h-2 mb-2" />
                    <div className="flex items-center justify-between text-xs text-muted-foreground gap-2 flex-wrap">
                      <span>{shipment.carrier?.companyName || "Carrier"}</span>
                      {shipment.eta && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          ETA: {format(new Date(shipment.eta), "h:mm a")}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                      <FileText className="h-3 w-3" />
                      <span>{shipment.documents.length} docs</span>
                      <Badge variant="secondary" className="text-xs py-0">
                        {shipment.documents.length}/4 uploaded
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="overflow-hidden flex flex-col min-h-0">
          {selectedShipment ? (
            <>
              <CardHeader className="pb-3 border-b border-border flex-shrink-0">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <CardTitle className="text-lg">
                      {selectedShipment.load?.pickupCity || "Origin"} to {selectedShipment.load?.dropoffCity || "Destination"}
                    </CardTitle>
                    <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
                      <span className="font-medium">{selectedShipment.carrier?.companyName}</span>
                      {selectedShipment.truck && (
                        <span>
                          {selectedShipment.truck.truckType} - {selectedShipment.truck.registrationNumber}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground flex items-center justify-end gap-1">
                      <Calendar className="h-3 w-3" />
                      {selectedShipment.currentStage === "delivered" ? "Delivered" : "Estimated Arrival"}
                    </p>
                    {estimatedArrival ? (
                      <div>
                        <p className="font-semibold text-lg" data-testid="text-eta-date">{estimatedArrival.date}</p>
                        <p className="text-sm text-muted-foreground" data-testid="text-eta-time">{estimatedArrival.time}</p>
                      </div>
                    ) : (
                      <p className="font-semibold text-muted-foreground">Pending</p>
                    )}
                  </div>
                </div>
                <Progress value={selectedShipment.progress} className="mt-4" />
              </CardHeader>
              <CardContent className="p-0 flex-1 min-h-0 overflow-auto">
                <div className="p-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <h3 className="font-semibold mb-4">Shipment Timeline</h3>
                    <div className="relative">
                      {selectedShipment.timeline.map((event, index) => {
                        const Icon = stageIcons[event.stage as ShipmentStage] || MapPin;
                        const isLast = index === selectedShipment.timeline.length - 1;
                        return (
                          <div key={event.stage} className="flex gap-4 pb-6 last:pb-0">
                            <div className="relative flex flex-col items-center">
                              <div className={`flex h-8 w-8 items-center justify-center rounded-full ${
                                event.completed 
                                  ? "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400" 
                                  : "bg-muted text-muted-foreground"
                              }`}>
                                <Icon className="h-4 w-4" />
                              </div>
                              {!isLast && (
                                <div className={`w-0.5 flex-1 mt-2 ${
                                  event.completed ? "bg-green-200 dark:bg-green-800" : "bg-border"
                                }`} />
                              )}
                            </div>
                            <div className="flex-1 pt-1">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <p className={`font-medium ${!event.completed && "text-muted-foreground"}`}>
                                  {stageLabels[event.stage as ShipmentStage] || event.stage}
                                </p>
                                {event.completed && (
                                  <CheckCircle className="h-4 w-4 text-green-500" />
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground">{event.location}</p>
                              {event.timestamp && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  {format(new Date(event.timestamp), "MMM d 'at' h:mm a")}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-4">Live Map</h3>
                    <div className="mb-6">
                      <ShipmentMap 
                        shipment={selectedShipment} 
                        onExpand={() => setMapFullscreen(true)}
                      />
                    </div>

                    <h3 className="font-semibold mb-4">Carrier & Truck Details</h3>
                    <div className="space-y-3 mb-6">
                      {selectedShipment.carrier?.carrierType === 'solo' ? (
                        <>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Driver</span>
                            <span className="font-medium">{selectedShipment.driver?.name || selectedShipment.carrier?.username || "N/A"}</span>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Trips Done</span>
                            <span className="font-medium">{selectedShipment.carrier?.tripsCompleted || 0}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Company</span>
                            <span className="font-medium">{selectedShipment.carrier?.companyName || "N/A"}</span>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Driver</span>
                            <span className="font-medium">{selectedShipment.driver?.name || "Pending assignment"}</span>
                          </div>
                        </>
                      )}
                      {selectedShipment.truck ? (
                        <>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Vehicle</span>
                            <span className="font-medium">{selectedShipment.truck.truckType}</span>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Truck No.</span>
                            <span className="font-medium">{selectedShipment.truck.registrationNumber}</span>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Capacity</span>
                            <span className="font-medium">{selectedShipment.truck.capacity} tons</span>
                          </div>
                        </>
                      ) : (
                        <div className="p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <Truck className="h-4 w-4" />
                            <span>Truck details will be available once the carrier assigns a vehicle</span>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between mb-4 gap-2">
                      <h3 className="font-semibold">Documents</h3>
                      {(() => {
                        const loadNum = selectedShipment.load?.adminReferenceNumber || selectedShipment.load?.shipperLoadNumber;
                        const loadId = loadNum ? `LD-${String(loadNum).padStart(3, '0')}` : '';
                        return (
                          <Link 
                            href={`/shipper/documents?load=${encodeURIComponent(loadId)}`}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                            data-testid="link-view-all-documents"
                          >
                            View All
                            <ArrowRight className="h-3 w-3" />
                          </Link>
                        );
                      })()}
                    </div>
                    <div className="space-y-2">
                      {[
                        { key: "lr_consignment", label: "LR / Consignment Note" },
                        { key: "eway_bill", label: "E-way Bill" },
                        { key: "loading_photos", label: "Loading Photos" },
                        { key: "pod", label: "Proof of Delivery (POD)" },
                      ].map((docItem) => {
                        const doc = selectedShipment.documents.find(d => 
                          d.documentType === docItem.key
                        );
                        return (
                          <div 
                            key={docItem.key} 
                            className="flex items-center justify-between p-3 bg-muted/50 rounded-lg hover-elevate cursor-pointer"
                            onClick={() => openDocumentViewer(docItem.label, docItem.key)}
                            data-testid={`document-${docItem.key}`}
                          >
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm">{docItem.label}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {doc?.status === "verified" ? (
                                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Verified
                                </Badge>
                              ) : doc ? (
                                <Badge variant="secondary">
                                  <ArrowRight className="h-3 w-3 mr-1" />
                                  Uploaded
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-muted-foreground">
                                  Pending
                                </Badge>
                              )}
                              <Eye className="h-4 w-4 text-muted-foreground" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="h-full flex items-center justify-center">
              <p className="text-muted-foreground">Select a shipment to view details</p>
            </CardContent>
          )}
        </Card>
      </div>

      <Dialog open={documentViewerOpen} onOpenChange={setDocumentViewerOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {selectedDocument?.type}
            </DialogTitle>
            <DialogDescription>
              {selectedShipment && (
                <span>
                  Load {formatLoadId(selectedShipment.load?.shipperLoadNumber, selectedShipment.load?.adminReferenceNumber)} - {selectedShipment.load?.pickupCity} to {selectedShipment.load?.dropoffCity}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {selectedDocument && (
            <div className="mt-4">
              <div className="border rounded-lg overflow-hidden bg-white dark:bg-slate-900">
                {selectedDocument.image.toLowerCase().endsWith('.pdf') ? (
                  <iframe 
                    src={selectedDocument.image.startsWith('/objects/') ? selectedDocument.image : `/objects/${selectedDocument.image}`}
                    className="w-full h-[60vh]"
                    title={selectedDocument.type}
                  />
                ) : (
                  <img 
                    src={selectedDocument.image.startsWith('/objects/') ? selectedDocument.image : `/objects/${selectedDocument.image}`}
                    alt={selectedDocument.type}
                    className="w-full h-auto object-contain"
                    data-testid="img-document-viewer"
                  />
                )}
              </div>
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => {
                    const link = document.createElement('a');
                    link.href = selectedDocument.image.startsWith('/objects/') ? selectedDocument.image : `/objects/${selectedDocument.image}`;
                    const ext = selectedDocument.image.split('.').pop() || 'file';
                    link.download = `${selectedDocument.type.replace(/[^a-z0-9]/gi, '_')}.${ext}`;
                    link.click();
                  }}
                  data-testid="button-download-document"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </Button>
                <Button 
                  size="sm"
                  onClick={() => setDocumentViewerOpen(false)}
                  data-testid="button-close-document"
                >
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={mapFullscreen} onOpenChange={setMapFullscreen}>
        <DialogContent className="max-w-6xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Navigation className="h-5 w-5" />
              Live Tracking Map
            </DialogTitle>
            <DialogDescription>
              {selectedShipment && (
                <span>
                  {selectedShipment.load?.pickupCity} to {selectedShipment.load?.dropoffCity} - {selectedShipment.progress}% complete
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {selectedShipment && (
            <div className="mt-4">
              <ShipmentMap shipment={selectedShipment} isFullscreen={true} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
