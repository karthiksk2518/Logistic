import { useState, useEffect } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface AuthenticatedAvatarProps {
  src?: string | null;
  alt?: string;
  fallback: string;
  className?: string;
  fallbackClassName?: string;
}

export function AuthenticatedAvatar({
  src,
  alt,
  fallback,
  className,
  fallbackClassName,
}: AuthenticatedAvatarProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!src) {
      setBlobUrl(null);
      setError(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(false);

    fetch(src, { credentials: "include" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to load image");
        }
        return response.blob();
      })
      .then((blob) => {
        if (!cancelled) {
          const url = URL.createObjectURL(blob);
          setBlobUrl(url);
        }
      })
      .catch((err) => {
        console.error("Avatar fetch error:", err);
        if (!cancelled) {
          setError(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [src]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  return (
    <Avatar className={className}>
      {blobUrl && !error ? (
        <AvatarImage src={blobUrl} alt={alt} />
      ) : null}
      <AvatarFallback className={fallbackClassName}>
        {loading ? "..." : fallback}
      </AvatarFallback>
    </Avatar>
  );
}
