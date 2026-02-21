import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MapPin, Loader2, Map } from "lucide-react";

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onAddressSelect?: (address: AddressComponents) => void;
  placeholder?: string;
  className?: string;
  "data-testid"?: string;
}

interface AddressComponents {
  streetAddress: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  formattedAddress: string;
  lat?: number;
  lng?: number;
}

declare global {
  interface Window {
    google: any;
    initGoogleMaps: () => void;
  }
}

export function AddressAutocomplete({
  value,
  onChange,
  onAddressSelect,
  placeholder = "Search for an address",
  className,
  "data-testid": testId,
}: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapSearchRef = useRef<HTMLInputElement | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const mapMarkerRef = useRef<any>(null);
  const mapAutocompleteRef = useRef<any>(null);
  const geocoderRef = useRef<any>(null);
  const [mapContainerReady, setMapContainerReady] = useState(false);
  const [mapSearchReady, setMapSearchReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoaded, setIsGoogleLoaded] = useState(false);
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const apiKey = useMemo(() => import.meta.env.VITE_GOOGLE_MAPS_API_KEY, []);

  useEffect(() => {
    if (!apiKey || apiKey.includes("${") || apiKey.length < 10) {
      return;
    }

    if (window.google?.maps?.places) {
      setIsGoogleLoaded(true);
      return;
    }

    setIsLoading(true);

    window.initGoogleMaps = () => {
      setIsGoogleLoaded(true);
      setIsLoading(false);
    };

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=initGoogleMaps`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);

    return () => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };
  }, []);

  useEffect(() => {
    if (!isGoogleLoaded || !inputRef.current || autocompleteRef.current) return;

    const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: "in" },
      types: ["geocode", "establishment"],
      fields: ["formatted_address", "address_components", "geometry"],
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place) return;
      handlePlaceSelection(place);
    });

    autocompleteRef.current = autocomplete;

    return () => {
      if (autocompleteRef.current) {
        window.google.maps.event.clearInstanceListeners(autocompleteRef.current);
      }
    };
  }, [isGoogleLoaded, onChange]);

  useEffect(() => {
    if (!isMapOpen) return;
    setMapError(null);
    if (!apiKey || apiKey.includes("${") || apiKey.length < 10) {
      setMapLoading(false);
      setMapError("Google Maps API key is not configured.");
      return;
    }
    if (!isGoogleLoaded) {
      setMapLoading(true);
      return;
    }
    if (!mapContainerReady || !mapContainerRef.current) {
      setMapLoading(true);
      return;
    }

    setMapLoading(true);

    const map = new window.google.maps.Map(mapContainerRef.current, {
      center: { lat: 20.5937, lng: 78.9629 },
      zoom: 5,
      fullscreenControl: false,
      mapTypeControl: false,
      streetViewControl: false,
    });

    const marker = new window.google.maps.Marker({
      map,
    });

    const geocoder = new window.google.maps.Geocoder();
    geocoderRef.current = geocoder;
    mapInstanceRef.current = map;
    mapMarkerRef.current = marker;

    map.addListener("click", (event: any) => {
      if (!event?.latLng || !geocoderRef.current) return;
      geocoderRef.current.geocode({ location: event.latLng }, (results: any, status: string) => {
        if (status !== "OK" || !results?.length) {
          setMapError("Unable to resolve address for that location.");
          return;
        }
        handlePlaceSelection(results[0]);
      });
    });

    window.google.maps.event.addListenerOnce(map, "idle", () => {
      setMapLoading(false);
    });

    return () => {
      if (mapInstanceRef.current) {
        window.google.maps.event.clearInstanceListeners(mapInstanceRef.current);
        mapInstanceRef.current = null;
      }
      mapMarkerRef.current = null;
      geocoderRef.current = null;
    };
  }, [apiKey, isGoogleLoaded, isMapOpen, mapContainerReady]);

  useEffect(() => {
    if (!isMapOpen || !isGoogleLoaded || !mapSearchReady || !mapSearchRef.current) return;
    if (mapAutocompleteRef.current) return;
    const autocomplete = new window.google.maps.places.Autocomplete(mapSearchRef.current, {
      componentRestrictions: { country: "in" },
      types: ["geocode", "establishment"],
      fields: ["formatted_address", "address_components", "geometry"],
    });
    mapAutocompleteRef.current = autocomplete;
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      handlePlaceSelection(place);
    });

    return () => {
      if (mapAutocompleteRef.current) {
        window.google.maps.event.clearInstanceListeners(mapAutocompleteRef.current);
        mapAutocompleteRef.current = null;
      }
    };
  }, [isGoogleLoaded, isMapOpen, mapSearchReady]);

  useEffect(() => {
    if (!isMapOpen || isGoogleLoaded || !isLoading) return;
    const timeout = setTimeout(() => {
      if (!isGoogleLoaded) {
        setMapLoading(false);
        setMapError("Google Maps failed to load.");
      }
    }, 10000);
    return () => clearTimeout(timeout);
  }, [isGoogleLoaded, isLoading, isMapOpen]);

  const handlePlaceSelection = (place: any) => {
    const parsed = parseAddressComponents(place);
    if (!parsed) {
      setMapError("Unable to read address details. Please choose another location.");
      return;
    }

    const missing = [];
    if (!parsed.formattedAddress) missing.push("address");
    if (!parsed.city) missing.push("city");
    if (!parsed.state) missing.push("state");
    if (!parsed.postalCode) missing.push("postal code");
    if (!parsed.country) missing.push("country");

    if (missing.length > 0) {
      setMapError(`Some fields are missing (${missing.join(", ")}). You can edit them manually.`);
    }

    if (place?.geometry?.location && mapInstanceRef.current && mapMarkerRef.current) {
      const location = place.geometry.location;
      mapInstanceRef.current.setCenter(location);
      mapInstanceRef.current.setZoom(15);
      mapMarkerRef.current.setPosition(location);
    }

    onChange(parsed.formattedAddress);
    onAddressSelect?.(parsed);
    if (missing.length === 0) {
      setMapError(null);
    }
    setIsMapOpen(false);
  };

  const parseAddressComponents = (place: any): AddressComponents | null => {
    if (!place?.address_components) {
      return null;
    }

    const getComponent = (types: string[]) =>
      place.address_components.find((component: any) =>
        types.some((type) => component.types.includes(type))
      )?.long_name || "";

    const streetNumber = getComponent(["street_number"]);
    const route = getComponent(["route"]);
    const streetAddress = [streetNumber, route].filter(Boolean).join(" ").trim();
    const city =
      getComponent(["locality"]) ||
      getComponent(["postal_town"]) ||
      getComponent(["administrative_area_level_2"]) ||
      getComponent(["sublocality"]) ||
      getComponent(["sublocality_level_1"]);
    const state = getComponent(["administrative_area_level_1"]);
    const postalCode = getComponent(["postal_code"]);
    const country = getComponent(["country"]);
    const formattedAddress = place.formatted_address || streetAddress;
    const lat = place?.geometry?.location?.lat?.();
    const lng = place?.geometry?.location?.lng?.();

    return {
      streetAddress,
      city,
      state,
      postalCode,
      country,
      formattedAddress,
      lat: typeof lat === "number" ? lat : undefined,
      lng: typeof lng === "number" ? lng : undefined,
    };
  };

  return (
    <div>
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MapPin className="h-4 w-4" />
          )}
        </div>
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`pl-10 pr-10 ${className || ""}`}
          data-testid={testId}
        />
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setIsMapOpen(true)}
          disabled={!apiKey || apiKey.includes("${") || apiKey.length < 10}
          aria-label="Open map picker"
        >
          <Map className="h-4 w-4" />
        </button>
      </div>
      {mapError ? <div className="mt-1 text-xs text-destructive">{mapError}</div> : null}
      <Dialog open={isMapOpen} onOpenChange={setIsMapOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Select location</DialogTitle>
            <DialogDescription>Search or click on the map to choose an address.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              ref={(node: HTMLInputElement | null) => {
                mapSearchRef.current = node;
                setMapSearchReady(Boolean(node));
              }}
              placeholder="Search for a place"
            />
            <div className="relative h-[420px] w-full overflow-hidden rounded-md border">
              <div
                ref={(node: HTMLDivElement | null) => {
                  mapContainerRef.current = node;
                  setMapContainerReady(Boolean(node));
                }}
                className="h-full w-full"
              />
              {mapLoading ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
