// One QueryClient for the whole app; the provider in app/_layout.tsx uses
// this instance. Import it for cache calls outside components, for example
// queryClient.invalidateQueries or setQueryData in websocket or push
// handlers; inside components useQueryClient() returns this same instance.
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Offline-first: try the network once, but always fall back to (and keep
      // showing) the last data we persisted to storage. This is what makes the
      // app usable with no connection.
      networkMode: "offlineFirst",
      retry: 1,
      staleTime: 30_000,
      gcTime: 1000 * 60 * 60 * 24 * 7, // keep cache a week for offline use
      refetchOnWindowFocus: false,
    },
  },
});
