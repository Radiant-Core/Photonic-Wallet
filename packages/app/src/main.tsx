// Side-effect import — MUST be first. Installs `globalThis.process` /
// `globalThis.Buffer` shims that `@radiant-core/radiantjs` reads at module
// init time. Replaces the inline <script> shim that previously violated
// the `script-src 'self'` CSP. See R28 in REMEDIATION_PLAN.md.
import "./processShim";
import {
  createHashRouter,
  Navigate,
  RouterProvider,
  useRouteError,
} from "react-router-dom";
import {
  ChakraProvider,
  extendTheme,
  ToastProviderProps,
  ButtonProps,
} from "@chakra-ui/react";
import ReactDOM from "react-dom/client";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";
// Side-effect import: registers the IndexedDB-backed adapter for the lib's
// timelock-reveal store so wrapped CEKs live in IndexedDB rather than
// localStorage. See packages/app/src/timelockStore.ts and R15 in
// REMEDIATION_PLAN.md. Must come before any reveal-flow component renders.
import "./timelockStore";
// Native-shell init (status bar, splash, safe-area class). No-op on web/Tauri.
import { initNative } from "./platform";
import App from "./App";
import Servers from "./pages/Servers";
import WalletSettings from "./pages/WalletSettings";
import CreateWallet from "./pages/CreateWallet";
import Root from "./pages/Root";
import RecoverWallet from "./pages/RecoverWallet";
import SettingsLayout from "./layouts/SettingsLayout";
import Mint from "./pages/Mint";
import Wallet from "./pages/Wallet";
import WalletLayout from "./layouts/WalletLayout";
import Coins from "./pages/Coins";
import MobileHome from "./pages/MobileHome";
import IpfsSettings from "./pages/IpfsSettings";
import About from "./pages/About";
import LogOut from "./pages/LogOut";
import gradient from "/gradient.svg";
import Exit from "./pages/Exit";
import Fungible from "./pages/Fungible";
import SetupLayout from "./layouts/SetupLayout";
import Swap from "./pages/Swap";
import SwapLayout from "./layouts/SwapLayout";
// Predict (RadiantSwap prediction markets) is lazy-loaded in the router below.
// Importing predict.ts -> radiantswap eagerly at app init pulled that heavy
// module graph into the initial evaluation and reordered the prod bundle,
// breaking a latent init cycle (a shared effect callback ended up undefined ->
// "e is not a function" white-screen, prod-build only). Deferring execution to
// route-visit time restores the working init order and code-splits the feature.
import "@fontsource-variable/inter";
import "@fontsource-variable/source-code-pro";
import "./index.css";
import SwapPending from "./pages/SwapPending";
import SwapCompleted from "./pages/SwapCompleted";
import SwapLoad from "./pages/SwapLoad";
import SwapMissing from "./pages/SwapMissing";
import OpenOrders from "./pages/OpenOrders";
import VaultPage from "./pages/Vault";
import MarketHub from "./pages/MarketHub";
import WaveRegister from "./pages/WaveRegister";
import WaveNames from "./pages/WaveNames";
import Connect from "./pages/Connect";

dayjs.extend(localizedFormat);

const theme = extendTheme({
  config: {
    initialColorMode: "dark",
    useSystemColorMode: false,
  },
  sizes: {
    container: {
      xl: "1600px",
    },
  },
  styles: {
    global: () => ({
      body: {
        bg: "bg.200",
      },
    }),
  },
  fonts: {
    heading: `'Inter Variable', sans-serif`,
    body: `'Inter Variable', sans-serif`,
    mono: `'Source Code Pro Variable', monospace`,
  },
  // Semantic aliases give every screen one vocabulary for surfaces, borders,
  // accents and feedback. They resolve to the raw palette below, so the visual
  // system can be retuned in one place without touching call sites.
  semanticTokens: {
    colors: {
      "surface.canvas": "bg.200",
      "surface.raised": "bg.100",
      "surface.overlay": "bg.100",
      "surface.sunken": "bg.300",
      "surface.hover": "whiteAlpha.50",
      "border.subtle": "whiteAlpha.50",
      "border.default": "whiteAlpha.100",
      "border.strong": "whiteAlpha.200",
      "accent.primary": "brand.500",
      "accent.focus": "brand.400",
      "accent.secondary": "lightBlue.A400",
      "text.secondary": "whiteAlpha.700",
      "text.muted": "whiteAlpha.500",
      // Alert/toast status fills (dark-only).
      "feedback.successBg": "#1C4532EE",
      "feedback.errorBg": "#C53030EE",
      "feedback.warningBg": "#C05621EE",
      "feedback.infoBg": "#1A365DEE",
    },
  },
  // Deliberate type scale on Inter Variable. Apply with `textStyle="h2"` etc.
  // `numeric` (tabular-nums) is for balances/amounts so digits don't jitter.
  textStyles: {
    display: {
      fontSize: "3xl",
      fontWeight: 700,
      lineHeight: 1.1,
      letterSpacing: "-0.02em",
    },
    h1: {
      fontSize: "2xl",
      fontWeight: 600,
      lineHeight: 1.2,
      letterSpacing: "-0.015em",
    },
    h2: {
      fontSize: "xl",
      fontWeight: 600,
      lineHeight: 1.25,
      letterSpacing: "-0.01em",
    },
    h3: { fontSize: "lg", fontWeight: 600, lineHeight: 1.3 },
    body: { fontSize: "md", fontWeight: 400, lineHeight: 1.55 },
    small: {
      fontSize: "sm",
      fontWeight: 400,
      lineHeight: 1.5,
      color: "whiteAlpha.700",
    },
    label: {
      fontSize: "xs",
      fontWeight: 600,
      lineHeight: 1.4,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      color: "whiteAlpha.600",
    },
    numeric: { fontVariantNumeric: "tabular-nums" },
  },
  components: {
    // Chakra's Heading size recipe (default size "xl" => fontSize 4xl, bold)
    // otherwise overrides `textStyle`, so every `textStyle="h2"` heading would
    // render at the same oversized default. Neutralise the size layer (empty
    // "unset" default size) and provide a gentle baseStyle fallback so the
    // `textStyle` token wins for fontSize/weight. Explicit `size="md"` etc.
    // still work (Chakra's built-in sizes remain merged in).
    Heading: {
      baseStyle: {
        fontWeight: 600,
        fontSize: "xl",
        lineHeight: 1.25,
        letterSpacing: "-0.01em",
      },
      sizes: {
        unset: {},
      },
      defaultProps: {
        size: "unset",
      },
    },
    Input: {
      defaultProps: {
        variant: "filled",
        focusBorderColor: "brand.400",
      },
      variants: {
        filled: {
          field: {
            bg: "whiteAlpha.50",
            borderWidth: "1px",
            borderColor: "border.default",
            transitionProperty: "background, border-color, box-shadow",
            transitionDuration: "0.18s",
            _hover: { bg: "whiteAlpha.100" },
            _focusVisible: {
              bg: "whiteAlpha.100",
              borderColor: "brand.400",
              boxShadow: "0 0 0 1px var(--chakra-colors-brand-400)",
            },
          },
        },
      },
    },
    Textarea: {
      defaultProps: {
        variant: "filled",
        focusBorderColor: "brand.400",
      },
      variants: {
        filled: {
          bg: "whiteAlpha.50",
          borderWidth: "1px",
          borderColor: "border.default",
          transitionProperty: "background, border-color, box-shadow",
          transitionDuration: "0.18s",
          _hover: { bg: "whiteAlpha.100" },
          _focusVisible: {
            bg: "whiteAlpha.100",
            borderColor: "brand.400",
            boxShadow: "0 0 0 1px var(--chakra-colors-brand-400)",
          },
        },
      },
    },
    Select: {
      defaultProps: {
        variant: "filled",
        focusBorderColor: "brand.400",
      },
    },
    Tag: {
      defaultProps: {
        variant: "solid",
        colorScheme: "deepPurple",
      },
      variants: {
        solid: {
          container: {
            bg: `deepPurple.A400`,
          },
        },
      },
    },
    Tabs: {
      variants: {
        line: {
          tab: {
            color: "whiteAlpha.600",
            fontWeight: "medium",
            transition: "color 0.18s ease",
            _hover: { color: "whiteAlpha.900" },
            _selected: {
              color: "white",
              borderColor: "brand.400",
              bg: `url(${gradient})`,
              bgSize: "cover",
              bgPosition: "center center",
            },
            _active: {
              bg: "transparent",
              borderColor: "brand.400",
            },
          },
        },
      },
    },
    Alert: {
      baseStyle: {
        container: {
          borderRadius: "lg",
        },
      },
      variants: {
        subtle: {
          container: {
            "&[data-status='success']": { bg: "feedback.successBg" },
            "&[data-status='error']": { bg: "feedback.errorBg" },
            "&[data-status='warning']": { bg: "feedback.warningBg" },
            "&[data-status='info']": { bg: "feedback.infoBg" },
          },
        },
      },
    },
    Button: {
      baseStyle: {
        transition: "all 0.15s ease",
        fontWeight: "semibold",
        borderRadius: "lg",
      },
      variants: {
        primary: (props: ButtonProps) => {
          return {
            ...theme.components.Button.variants.solid(props),
            position: "relative",
            bg: `url(${gradient})`,
            bgSize: "cover",
            bgPosition: "center center",
            _hover: {
              filter: "brightness(1.12)",
              transform: "translateY(-1px)",
              boxShadow: "glowBrand",
              _disabled: {
                bg: "deepPurple.A700",
                transform: "none",
                boxShadow: "none",
              },
            },
            _active: {
              filter: "brightness(1.3)",
              transform: "translateY(0)",
            },
          };
        },
        solid: {
          bg: "whiteAlpha.200",
          _hover: {
            bg: "whiteAlpha.300",
            transform: "translateY(-1px)",
          },
          _active: {
            bg: "whiteAlpha.400",
            transform: "translateY(0)",
          },
        },
        ghost: {
          _hover: {
            bg: "whiteAlpha.100",
          },
        },
        // Tinted secondary action — quieter than `solid`, clearly on-brand.
        subtle: {
          bg: "rgba(74, 78, 255, 0.12)",
          color: "brand.200",
          _hover: { bg: "rgba(74, 78, 255, 0.2)", transform: "translateY(-1px)" },
          _active: { bg: "rgba(74, 78, 255, 0.28)", transform: "translateY(0)" },
        },
      },
    },
    Modal: {
      baseStyle: {
        overlay: {
          bg: "blackAlpha.600",
          backdropFilter: "blur(24px)",
        },
        dialog: {
          mx: { base: 4, md: 0 },
          bg: "surface.overlay",
          borderWidth: "1px",
          borderColor: "border.default",
          borderRadius: "xl",
          boxShadow: "xl",
        },
        header: {
          fontWeight: "semibold",
          letterSpacing: "-0.01em",
        },
        body: {
          display: "flex",
          flexDirection: "column",
        },
      },
    },
    Divider: {
      baseStyle: {
        borderColor: "border.subtle",
      },
    },
  },
  // Material colors
  colors: {
    gray: {
      50: "#F7F7F7",
      100: "#EDEDED",
      200: "#E2E2E2",
      300: "#CBCBCB",
      400: "#A0A0A0",
      500: "#717171",
      600: "#4A4A4A",
      700: "#2D2D2D",
      800: "#1A1A1A",
      900: "#171717",
    },
    brand: {
      50: "#e8eaff",
      100: "#c4c6ff",
      200: "#9da2ff",
      300: "#757dff",
      400: "#5c64ff",
      500: "#4a4eff",
      600: "#4845f7",
      700: "#4339ea",
      800: "#3e2cdd",
      900: "#3400ca",
    },
    purple: {
      50: "#f3e5f5",
      100: "#e1bee7",
      200: "#ce93d8",
      300: "#ba68c8",
      400: "#ab47bc",
      500: "#9c27b0",
      600: "#8e24aa",
      700: "#7b1fa2",
      800: "#6a1b9a",
      900: "#4a148c",
      A100: "#ea80fc",
      A200: "#e040fb",
      A400: "#d500f9",
      A700: "#aa00ff",
    },
    deepPurple: {
      50: "#ede7f6",
      100: "#d1c4e9",
      200: "#b39ddb",
      300: "#9575cd",
      400: "#7e57c2",
      500: "#673ab7",
      600: "#5e35b1",
      700: "#512da8",
      800: "#4527a0",
      900: "#311b92",
      A100: "#b388ff",
      A200: "#7c4dff",
      A400: "#651fff",
      A700: "#6200ea",
    },
    lightBlue: {
      50: "#e1f5fe",
      100: "#b3e5fc",
      200: "#81d4fa",
      300: "#4fc3f7",
      400: "#29b6f6",
      500: "#03a9f4",
      600: "#039be5",
      700: "#0288d1",
      800: "#0277bd",
      900: "#01579b",
      A100: "#80d8ff",
      A200: "#40c4ff",
      A400: "#00b0ff",
      A700: "#0091ea",
    },
    bg: {
      // Cooler, more even dark elevation ladder (~+10 luminance per step).
      // Keys preserved so all existing `bg.*` call sites keep resolving.
      50: "#30303a", // hover fill on raised surfaces
      100: "#24242e", // raised: cards, modals, token tiles
      200: "#1a1a24", // canvas / body
      300: "#14141e", // sidebar, wells, sunken
      400: "#0e0e16", // deepest
    },
    blueGrayAlpha: {
      50: "#4A55680a",
      100: "#4A55680f",
      200: "#4A556814",
      300: "#4A556828",
      400: "#4A55683D",
      500: "#4A55685B",
      600: "#4A55687A",
      700: "#4A5568A3",
      800: "#4A5568CC",
      900: "#4A5568EA",
    },
  },
  shadows: {
    // Deliberate dark-tuned elevation scale. The faint 1px inner ring keeps
    // raised surfaces crisp against the dark canvas.
    xs: "0 1px 2px rgba(0, 0, 0, 0.4)",
    sm: "0 2px 8px rgba(0, 0, 0, 0.35)",
    md: "0 6px 20px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.3)",
    lg: "0 12px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.3)",
    xl: "0 24px 60px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
    glowBrand: "0 4px 18px rgba(74, 78, 255, 0.35)",
    // Back-compat alias — existing `shadow="dark-md"` call sites resolve to `md`.
    "dark-md": "0 6px 20px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.3)",
  },
  radii: {
    sm: "6px",
    md: "8px",
    lg: "10px",
    xl: "14px",
    "2xl": "20px",
  },
});

function ErrorPage() {
  const error = useRouteError() as Error & { statusText?: string };
  console.error("[ErrorPage]", error);
  return (
    <div className="error-page">
      <h1>Something went wrong</h1>
      <pre className="error-page-pre">
        {error?.message || error?.statusText || JSON.stringify(error)}
      </pre>
      <pre className="error-page-stack">{error?.stack}</pre>
    </div>
  );
}

const router = createHashRouter([
  {
    path: "/",
    element: <App />,
    errorElement: <ErrorPage />,
    children: [
      {
        path: "",
        element: <Root />,
      },
      {
        element: <SetupLayout />,
        children: [
          {
            path: "/create-wallet",
            element: <CreateWallet />,
          },
          {
            path: "/recover",
            element: <RecoverWallet />,
          },
        ],
      },
      {
        element: <WalletLayout />,
        children: [
          {
            path: "/home",
            element: <MobileHome />,
          },
          {
            path: "/container/:containerRef/:page?/:lastId?",
            element: <Wallet />,
          },
          {
            path: "/container/:containerRef/token/:sref/:page?/:lastId?",
            element: <Wallet />,
          },
          {
            path: "/objects/:page?/:lastId?",
            element: <Wallet />,
          },
          {
            path: "/objects/token/:sref",
            element: <Wallet />,
          },
          {
            path: "/fungible",
            element: <Fungible />,
          },
          {
            path: "/fungible/token/:sref",
            element: <Fungible />,
          },
          {
            path: "/coins",
            element: <Coins />,
          },
          {
            path: "/vault",
            element: <VaultPage />,
          },
          {
            path: "/market",
            element: <MarketHub />,
          },
          {
            path: "/connect",
            element: <Connect />,
          },
          {
            // External TRANSACTION signing (Xetch bridge). A separate route
            // from /connect on purpose: that page promises it cannot spend,
            // and this one exists to spend. Lazy — it pulls the whole
            // bridge-kit pricing/builder chain, which no other page needs.
            path: "/sign",
            lazy: async () => ({
              Component: (await import("./pages/SignAction")).default,
            }),
          },
          {
            // History/activity folded into the unified History tab (/coins).
            path: "/history",
            element: <Navigate to="/coins" replace />,
          },
          {
            element: <SwapLayout />,
            children: [
              {
                path: "/swap",
                element: <Swap />,
              },
              {
                path: "/swap/pending",
                element: <SwapPending />,
              },
              {
                path: "/swap/completed",
                element: <SwapCompleted />,
              },
              {
                path: "/swap/missing",
                element: <SwapMissing />,
              },
              {
                path: "/swap/load",
                element: <SwapLoad />,
              },
              {
                path: "/swap/orders",
                element: <OpenOrders />,
              },
              {
                // Folded into the unified Market hub; redirect old bookmarks.
                path: "/swap/browse",
                element: <Navigate to="/market" replace />,
              },
            ],
          },
          {
            // Scoped error boundary: a render throw in any predict page is caught here and shown
            // inside the app shell, rather than bubbling to the root and blanking the whole app.
            errorElement: <ErrorPage />,
            lazy: async () => ({
              Component: (await import("./layouts/PredictLayout")).default,
            }),
            children: [
              {
                path: "/predict",
                lazy: async () => ({
                  Component: (await import("./pages/Predict")).default,
                }),
              },
              {
                path: "/predict/create",
                lazy: async () => ({
                  Component: (await import("./pages/PredictCreate")).default,
                }),
              },
              {
                path: "/predict/m/:createTxid",
                lazy: async () => ({
                  Component: (await import("./pages/PredictMarket")).default,
                }),
              },
              {
                path: "/predict/cat/:createTxid",
                lazy: async () => ({
                  Component: (await import("./pages/PredictCatMarket")).default,
                }),
              },
            ],
          },

          {
            path: "/mint/user",
            element: <Mint tokenType="user" />,
          },
          {
            path: "/mint/container",
            element: <Mint tokenType="container" />,
          },
          {
            path: "/mint/object",
            element: <Mint tokenType="object" />,
          },
          {
            path: "/mint/fungible",
            element: <Mint tokenType="fungible" />,
          },
          {
            path: "/names",
            element: <WaveRegister />,
          },
          {
            path: "/wave-names",
            element: <WaveNames />,
          },
          {
            // WAVE names-for-sale folded into the unified Market hub (Names filter).
            path: "/wave-names/market",
            element: <Navigate to="/market?filter=names" replace />,
          },
          {
            element: <SettingsLayout />,
            children: [
              {
                path: "/settings/servers",
                element: <Servers />,
              },
              {
                path: "/settings/wallet",
                element: <WalletSettings />,
              },
              {
                path: "/settings/about",
                element: <About />,
              },
              {
                path: "/settings/ipfs",
                element: <IpfsSettings />,
              },
              {
                path: "/settings/logout",
                element: <LogOut />,
              },
            ],
          },
        ],
      },
      { path: "/exit", element: <Exit /> },
    ],
  },
]);

const toastOptions: ToastProviderProps = {
  defaultOptions: {
    containerStyle: {
      mb: 14,
    },
    duration: 5000,
    variant: "subtle",
  },
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  /*<React.StrictMode>*/
  <ChakraProvider theme={theme} toastOptions={toastOptions}>
    <RouterProvider router={router} />
  </ChakraProvider>
  /*</React.StrictMode>*/
);

// Style the native status bar and dismiss the launch splash once the UI is up.
void initNative();
