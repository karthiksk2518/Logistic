import { useState, useRef, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { Truck, MapPin, Package, FileText, ArrowRight, Upload, X, Loader2, Shield, Check, ChevronsUpDown, Search } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useForm } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { indianTruckManufacturers, getModelsByManufacturer } from "@shared/indian-truck-data";
import { sortedIndianStates, getCitiesByState } from "@shared/indian-locations";

const truckFormSchema = z.object({
  truckType: z.string().min(1, "Truck type is required"),
  licensePlate: z.string().min(1, "License plate is required"),
  capacity: z.string().min(1, "Capacity is required"),
  capacityUnit: z.string().default("tons"),
  currentLocationState: z.string().min(1, "State is required"),
  currentLocationCity: z.string().min(1, "City is required"),
  isAvailable: z.boolean().default(false),
  manufacturerId: z.string().min(1, "Manufacturer is required"),
  model: z.string().min(1, "Model is required"),
  year: z.string().min(1, "Year is required"),
  registrationNumber: z.string().optional(),
  chassisNumber: z.string().optional(),
  bodyType: z.string().optional(),
  permitType: z.enum(["national", "domestic"]).optional(),
});

type TruckFormData = z.infer<typeof truckFormSchema>;

import { indianTruckTypes, truckCategories } from "@shared/schema";

const truckTypesByCategory = truckCategories.reduce((acc, category) => {
  acc[category] = indianTruckTypes.filter(t => t.category === category);
  return acc;
}, {} as Record<string, typeof indianTruckTypes[number][]>);

const categoryLabels: Record<string, string> = {
  open: "Open Body (7.5-43 Ton)",
  container: "Container (7.5-30 Ton)",
  lcv: "LCV (2.5-7 Ton)",
  mini_pickup: "Mini/Pickup (0.75-2 Ton)",
  trailer: "Trailer (16-43 Ton)",
  tipper: "Tipper (9-30 Ton)",
  tanker: "Tanker (8-36 Ton)",
  dumper: "Dumper (9-36 Ton)",
  bulker: "Bulker (20-36 Ton)",
};

interface DocumentFile {
  file: File;
  name: string;
  type: string;
}

export default function AddTruckPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { carrierType } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const rcInputRef = useRef<HTMLInputElement>(null);
  const insuranceInputRef = useRef<HTMLInputElement>(null);
  const fitnessInputRef = useRef<HTMLInputElement>(null);
  const permitInputRef = useRef<HTMLInputElement>(null);
  const pucInputRef = useRef<HTMLInputElement>(null);
  const isSoloCarrier = carrierType === "solo";
  const [truckTypeOpen, setTruckTypeOpen] = useState(false);
  
  // Create a flat list of all truck types with category info for searching
  const allTruckTypes = useMemo(() => {
    return indianTruckTypes.map(type => ({
      ...type,
      categoryLabel: categoryLabels[type.category] || type.category,
    }));
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, docType: string) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      // Remove any existing document of this type and add new one
      setDocuments(prev => [...prev.filter(d => d.type !== docType), { file, name: file.name, type: docType }]);
    }
    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const removeDocument = (docType: string) => {
    setDocuments(prev => prev.filter(d => d.type !== docType));
  };
  
  const getDocumentByType = (docType: string) => {
    return documents.find(d => d.type === docType);
  };

  // Fetch carrier onboarding data to auto-populate for solo carriers
  interface OnboardingResponse {
    id: string;
    carrierId: string;
    status: string;
    carrierType: string;
    licensePlateNumber?: string;
    chassisNumber?: string;
    uniqueRegistrationNumber?: string;
    permitType?: string;
  }
  
  const { data: onboardingData } = useQuery<OnboardingResponse>({
    queryKey: ["/api/carrier/onboarding"],
    enabled: isSoloCarrier,
  });

  const form = useForm<TruckFormData>({
    resolver: zodResolver(truckFormSchema),
    defaultValues: {
      truckType: "",
      licensePlate: "",
      capacity: "",
      capacityUnit: "tons",
      currentLocationState: "",
      currentLocationCity: "",
      isAvailable: false,
      manufacturerId: "",
      model: "",
      year: "",
      registrationNumber: "",
      chassisNumber: "",
      bodyType: "",
      permitType: undefined,
    },
  });

  // Auto-populate form from onboarding data for solo carriers
  useEffect(() => {
    // Only auto-populate if this is a solo carrier and onboarding data is for solo type
    if (isSoloCarrier && onboardingData && onboardingData.carrierType === "solo") {
      if (onboardingData.licensePlateNumber) {
        form.setValue("licensePlate", onboardingData.licensePlateNumber);
      }
      if (onboardingData.chassisNumber) {
        form.setValue("chassisNumber", onboardingData.chassisNumber);
      }
      if (onboardingData.uniqueRegistrationNumber) {
        form.setValue("registrationNumber", onboardingData.uniqueRegistrationNumber);
      }
      if (onboardingData.permitType === "national" || onboardingData.permitType === "domestic") {
        form.setValue("permitType", onboardingData.permitType);
      }
    }
  }, [isSoloCarrier, onboardingData, form]);

  // Watch the form values for cascading dropdowns
  const manufacturerId = form.watch("manufacturerId");
  const currentLocationState = form.watch("currentLocationState");
  const availableModels = manufacturerId ? getModelsByManufacturer(manufacturerId) : [];
  const availableCities = currentLocationState ? getCitiesByState(currentLocationState) : [];

  const handleSubmit = async (data: TruckFormData) => {
    setIsLoading(true);
    const stateName = sortedIndianStates.find(s => s.code === data.currentLocationState)?.name || data.currentLocationState;
    const currentLocation = `${data.currentLocationCity}, ${stateName}`;
    const manufacturer = indianTruckManufacturers.find(m => m.id === data.manufacturerId);
    try {
      const response = await fetch("/api/trucks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          truckType: data.truckType,
          licensePlate: data.licensePlate,
          capacity: Number(data.capacity),
          capacityUnit: data.capacityUnit,
          currentLocation: currentLocation,
          city: data.currentLocationCity,
          isAvailable: data.isAvailable,
          make: manufacturer?.name || data.manufacturerId,
          model: data.model,
          year: data.year ? Number(data.year) : undefined,
          registrationNumber: data.registrationNumber || undefined,
          chassisNumber: data.chassisNumber || undefined,
          bodyType: data.bodyType || undefined,
          permitType: data.permitType || undefined,
        }),
      });

      if (response.ok) {
        const truck = await response.json();
        
        // Upload documents if any
        if (documents.length > 0) {
          const docTypeLabels: Record<string, string> = {
            rc: "Registration Certificate",
            insurance: "Insurance",
            fitness: "Fitness Certificate",
            permit: "Permit",
            puc: "PUC Certificate",
          };
          for (const doc of documents) {
            try {
              const reader = new FileReader();
              await new Promise<void>((resolve, reject) => {
                reader.onload = async () => {
                  const fileUrl = reader.result as string;
                  // Format filename with truck number as title
                  const docLabel = docTypeLabels[doc.type] || doc.type.toUpperCase();
                  const formattedFileName = `${data.licensePlate} - ${docLabel}`;
                  await fetch("/api/carrier/documents", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({
                      documentType: doc.type,
                      fileName: formattedFileName,
                      fileUrl: fileUrl,
                      fileSize: doc.file.size,
                      expiryDate: null,
                      truckId: truck.id,
                    }),
                  });
                  resolve();
                };
                reader.onerror = reject;
                reader.readAsDataURL(doc.file);
              });
            } catch (docError) {
              console.error("Failed to upload document:", docError);
            }
          }
        }
        
        // Invalidate trucks and documents queries for real-time update
        queryClient.invalidateQueries({ queryKey: ["/api/trucks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/carrier/documents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/carrier/documents/expiring"] });
        
        toast({ title: "Truck added!", description: "Your truck is now listed and ready for loads." });
        navigate(isSoloCarrier ? "/carrier/my-truck" : "/carrier/fleet");
      } else {
        toast({ title: "Error", description: "Failed to add truck. Please try again.", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Error", description: "Something went wrong.", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Add New Truck</h1>
        <p className="text-muted-foreground">Register a new vehicle to your fleet.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Truck className="h-4 w-4" />
                Vehicle Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="manufacturerId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Manufacturer</FormLabel>
                      <Select 
                        onValueChange={(value) => {
                          field.onChange(value);
                          form.setValue("model", "");
                        }} 
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-manufacturer">
                            <SelectValue placeholder="Select manufacturer" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-[300px]">
                          {indianTruckManufacturers.map((manufacturer) => (
                            <SelectItem key={manufacturer.id} value={manufacturer.id}>
                              {manufacturer.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="model"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Model</FormLabel>
                      <Select 
                        onValueChange={field.onChange} 
                        value={field.value}
                        disabled={!manufacturerId}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-model">
                            <SelectValue placeholder={manufacturerId ? "Select model" : "Select manufacturer first"} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-[300px]">
                          {availableModels.map((model) => (
                            <SelectItem key={model.name} value={model.name}>
                              {model.name} ({model.capacityRange})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="year"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Year of Manufacture</FormLabel>
                      <FormControl>
                        <Input type="number" placeholder="2023" min="1990" max={new Date().getFullYear()} {...field} data-testid="input-year" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="truckType"
                  render={({ field }) => (
                    <FormItem className="flex flex-col">
                      <FormLabel>Truck Type</FormLabel>
                      <Popover open={truckTypeOpen} onOpenChange={setTruckTypeOpen}>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              variant="outline"
                              role="combobox"
                              aria-expanded={truckTypeOpen}
                              className={cn(
                                "w-full justify-between font-normal",
                                !field.value && "text-muted-foreground"
                              )}
                              data-testid="select-truck-type"
                            >
                              {field.value
                                ? allTruckTypes.find((type) => type.value === field.value)?.label
                                : "Select truck type"}
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent className="w-[300px] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search truck type..." />
                            <CommandList className="max-h-[300px]">
                              <CommandEmpty>No truck type found.</CommandEmpty>
                              {truckCategories.map((category) => (
                                <CommandGroup key={category} heading={categoryLabels[category]}>
                                  {truckTypesByCategory[category]?.map((type) => (
                                    <CommandItem
                                      key={type.value}
                                      value={`${type.label} ${categoryLabels[category]}`}
                                      onSelect={() => {
                                        field.onChange(type.value);
                                        setTruckTypeOpen(false);
                                      }}
                                    >
                                      <Check
                                        className={cn(
                                          "mr-2 h-4 w-4",
                                          field.value === type.value ? "opacity-100" : "opacity-0"
                                        )}
                                      />
                                      {type.label}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              ))}
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="licensePlate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>License Plate</FormLabel>
                      <FormControl>
                        <Input placeholder="MH-01-AB-1234" {...field} data-testid="input-license-plate" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="registrationNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Registration Number (RC)</FormLabel>
                      <FormControl>
                        <Input placeholder="Same as license plate if not available" {...field} data-testid="input-registration-number" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="chassisNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Chassis Number <span className="text-muted-foreground font-normal">(e.g. MAT123456789012345)</span></FormLabel>
                      <FormControl>
                        <Input placeholder="" {...field} data-testid="input-chassis-number" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bodyType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Body Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-body-type">
                            <SelectValue placeholder="Select body type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="open">Open Body</SelectItem>
                          <SelectItem value="closed">Closed Body</SelectItem>
                          <SelectItem value="container">Container</SelectItem>
                          <SelectItem value="flatbed">Flatbed</SelectItem>
                          <SelectItem value="tanker">Tanker</SelectItem>
                          <SelectItem value="tipper">Tipper</SelectItem>
                          <SelectItem value="trailer">Trailer</SelectItem>
                          <SelectItem value="refrigerated">Refrigerated</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="permitType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Shield className="h-4 w-4" />
                      Permit Type
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger data-testid="select-permit-type">
                          <SelectValue placeholder="Select permit type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="national">National Permit (All India)</SelectItem>
                        <SelectItem value="domestic">State Permit</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4" />
                Capacity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="capacity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Load Capacity</FormLabel>
                    <FormControl>
                      <div className="flex gap-2">
                        <Input 
                          type="number" 
                          placeholder="25" 
                          {...field} 
                          data-testid="input-capacity" 
                        />
                        <Select
                          defaultValue="tons"
                          onValueChange={(value) => form.setValue("capacityUnit", value)}
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="tons">tons</SelectItem>
                            <SelectItem value="lbs">lbs</SelectItem>
                            <SelectItem value="kg">kg</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Location & Availability
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="isAvailable"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div>
                      <FormLabel className="text-base">Available for loads</FormLabel>
                      <p className="text-sm text-muted-foreground">
                        Mark this truck as available to receive load recommendations
                      </p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="switch-available"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="currentLocationState"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>State</FormLabel>
                      <Select 
                        onValueChange={(value) => {
                          field.onChange(value);
                          form.setValue("currentLocationCity", "");
                        }} 
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-state">
                            <SelectValue placeholder="Select state" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-[300px]">
                          {sortedIndianStates.map((state) => (
                            <SelectItem key={state.code} value={state.code}>
                              {state.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="currentLocationCity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>City</FormLabel>
                      <Select 
                        onValueChange={field.onChange} 
                        value={field.value}
                        disabled={!currentLocationState}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-city">
                            <SelectValue placeholder={currentLocationState ? "Select city" : "Select state first"} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-[300px]">
                          {availableCities.map((city) => (
                            <SelectItem key={city.name} value={city.name}>
                              {city.name} {city.isMetro && "(Metro)"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Documents (Optional)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Hidden file inputs for each document type */}
              <input
                ref={rcInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                className="hidden"
                onChange={(e) => handleFileSelect(e, "rc")}
                data-testid="input-rc-upload"
              />
              <input
                ref={insuranceInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                className="hidden"
                onChange={(e) => handleFileSelect(e, "insurance")}
                data-testid="input-insurance-upload"
              />
              <input
                ref={fitnessInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                className="hidden"
                onChange={(e) => handleFileSelect(e, "fitness")}
                data-testid="input-fitness-upload"
              />
              <input
                ref={permitInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                className="hidden"
                onChange={(e) => handleFileSelect(e, "permit")}
                data-testid="input-permit-upload"
              />
              <input
                ref={pucInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                className="hidden"
                onChange={(e) => handleFileSelect(e, "puc")}
                data-testid="input-puc-upload"
              />

              {/* RC Document */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">RC (Registration Certificate)</Label>
                {getDocumentByType("rc") ? (
                  <div className="flex items-center justify-between gap-2 p-3 border rounded-md bg-muted/30">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                      <span className="text-sm truncate">{getDocumentByType("rc")?.name}</span>
                      <Badge variant="secondary" className="flex-shrink-0 text-xs">Uploaded</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeDocument("rc")}
                      data-testid="button-remove-rc"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div 
                    onClick={() => rcInputRef.current?.click()}
                    className="border-2 border-dashed border-border rounded-lg p-4 text-center hover-elevate cursor-pointer"
                    data-testid="dropzone-rc"
                  >
                    <Upload className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">Click to upload RC (PDF, JPG, PNG)</p>
                  </div>
                )}
              </div>

              {/* Insurance Document */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Insurance Certificate</Label>
                {getDocumentByType("insurance") ? (
                  <div className="flex items-center justify-between gap-2 p-3 border rounded-md bg-muted/30">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                      <span className="text-sm truncate">{getDocumentByType("insurance")?.name}</span>
                      <Badge variant="secondary" className="flex-shrink-0 text-xs">Uploaded</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeDocument("insurance")}
                      data-testid="button-remove-insurance"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div 
                    onClick={() => insuranceInputRef.current?.click()}
                    className="border-2 border-dashed border-border rounded-lg p-4 text-center hover-elevate cursor-pointer"
                    data-testid="dropzone-insurance"
                  >
                    <Upload className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">Click to upload Insurance (PDF, JPG, PNG)</p>
                  </div>
                )}
              </div>

              {/* Fitness Certificate */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Fitness Certificate</Label>
                {getDocumentByType("fitness") ? (
                  <div className="flex items-center justify-between gap-2 p-3 border rounded-md bg-muted/30">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                      <span className="text-sm truncate">{getDocumentByType("fitness")?.name}</span>
                      <Badge variant="secondary" className="flex-shrink-0 text-xs">Uploaded</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeDocument("fitness")}
                      data-testid="button-remove-fitness"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div 
                    onClick={() => fitnessInputRef.current?.click()}
                    className="border-2 border-dashed border-border rounded-lg p-4 text-center hover-elevate cursor-pointer"
                    data-testid="dropzone-fitness"
                  >
                    <Upload className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">Click to upload Fitness Certificate (PDF, JPG, PNG)</p>
                  </div>
                )}
              </div>

              {/* Permit Document */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Permit Document</Label>
                {getDocumentByType("permit") ? (
                  <div className="flex items-center justify-between gap-2 p-3 border rounded-md bg-muted/30">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                      <span className="text-sm truncate">{getDocumentByType("permit")?.name}</span>
                      <Badge variant="secondary" className="flex-shrink-0 text-xs">Uploaded</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeDocument("permit")}
                      data-testid="button-remove-permit"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div 
                    onClick={() => permitInputRef.current?.click()}
                    className="border-2 border-dashed border-border rounded-lg p-4 text-center hover-elevate cursor-pointer"
                    data-testid="dropzone-permit"
                  >
                    <Upload className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">Click to upload Permit (PDF, JPG, PNG)</p>
                  </div>
                )}
              </div>

              {/* PUC Certificate */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">PUC Certificate</Label>
                {getDocumentByType("puc") ? (
                  <div className="flex items-center justify-between gap-2 p-3 border rounded-md bg-muted/30">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                      <span className="text-sm truncate">{getDocumentByType("puc")?.name}</span>
                      <Badge variant="secondary" className="flex-shrink-0 text-xs">Uploaded</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeDocument("puc")}
                      data-testid="button-remove-puc"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div 
                    onClick={() => pucInputRef.current?.click()}
                    className="border-2 border-dashed border-border rounded-lg p-4 text-center hover-elevate cursor-pointer"
                    data-testid="dropzone-puc"
                  >
                    <Upload className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">Click to upload PUC Certificate (PDF, JPG, PNG)</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Button type="submit" className="w-full" disabled={isLoading} data-testid="button-add-truck">
            {isLoading ? "Adding..." : "Add Truck to Fleet"}
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </form>
      </Form>
    </div>
  );
}
