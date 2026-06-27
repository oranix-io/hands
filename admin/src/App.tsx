import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  useParams,
  useNavigate,
  Link,
} from "react-router-dom";
import { AppsList } from "./pages/AppsList";
import { AppDetail } from "./pages/AppDetail";
import { AuditLog } from "./pages/AuditLog";
import { Settings } from "./pages/Settings";
import { Publishing } from "./pages/Publishing";

function Header() {
  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-6">
        <Link to="/" className="text-xl font-bold tracking-tight">
          quiver
        </Link>
        <nav className="flex gap-2">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-md text-sm ${
                isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
              }`
            }
          >
            Apps
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-md text-sm ${
                isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
              }`
            }
          >
            Settings
          </NavLink>
        </nav>
      </div>
    </header>
  );
}

function AppContextNav() {
  const { appId } = useParams();
  if (!appId) return null;
  const base = `/apps/${appId}`;
  return (
    <div className="bg-white border-b border-slate-200 -mt-px">
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-2">
        <span className="text-xs text-slate-500 mr-2">App context:</span>
        <NavLink
          to={base}
          end
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Versions
        </NavLink>
        <NavLink
          to={`${base}/publish`}
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Publish
        </NavLink>
        <NavLink
          to={`${base}/audit`}
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Audit
        </NavLink>
      </div>
    </div>
  );
}

function AppDetailRoute() {
  const { appId } = useParams();
  const navigate = useNavigate();
  if (!appId) return null;
  return (
    <AppDetail
      appId={appId}
      onShowAudit={() => navigate(`/apps/${appId}/audit`)}
      onShowPublish={() => navigate(`/apps/${appId}/publish`)}
    />
  );
}

function AuditRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AuditLog appId={appId} />;
}

function PublishingRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <Publishing appId={appId} />;
}

export function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        <Header />
        <Routes>
          <Route path="/" element={<AppsListWithNav />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/apps/:appId" element={<AppShell />}>
            <Route index element={<AppDetailRoute />} />
            <Route path="publish" element={<PublishingRoute />} />
            <Route path="audit" element={<AuditRoute />} />
          </Route>
          <Route
            path="*"
            element={
              <div className="max-w-5xl mx-auto px-4 py-8">
                <p className="text-slate-500">404 — not found</p>
              </div>
            }
          />
        </Routes>
        <footer className="bg-white border-t border-slate-200 py-4 mt-8">
          <div className="max-w-5xl mx-auto px-4 text-xs text-slate-500">
            quiver admin · Cloudflare Native APK distribution
          </div>
        </footer>
      </div>
    </BrowserRouter>
  );
}

function AppsListWithNav() {
  const navigate = useNavigate();
  return (
    <main className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full">
      <AppsList onSelectApp={(appId) => navigate(`/apps/${appId}`)} />
    </main>
  );
}

function AppShell() {
  return (
    <>
      <AppContextNav />
      <main className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full">
        <Routes>
          <Route index element={<AppDetailRoute />} />
          <Route path="publish" element={<PublishingRoute />} />
          <Route path="audit" element={<AuditRoute />} />
        </Routes>
      </main>
    </>
  );
}