import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useState, useEffect } from 'react';
import SyncStatusWidget from './SyncStatusWidget';
import OfflineUnlockBanner from './OfflineUnlockBanner';
import NotificationBell from './NotificationBell';
import GlobalSearch from './GlobalSearch';
import { startLocalDataKeeper } from '../offline/localData';
import { startSyncCoordinator } from '../offline/syncCoordinator';
import { startTerminalReporting } from '../offline/terminalReporting';
import { startRealtime } from '../offline/realtime';
import { startReliability } from '../offline/reliability';
import {
  FiGrid,
  FiShoppingCart,
  FiClock,
  FiBox,
  FiTruck,
  FiUsers,
  FiUserCheck,
  FiEye,
  FiDollarSign,
  FiBarChart2,
  FiUserPlus,
  FiTag,
  FiMapPin,
  FiMoon,
  FiSun,
  FiLogOut,
  FiMenu,
  FiActivity,
  FiBookOpen,
  FiClipboard,
  FiHome,
  FiShuffle,
  FiHeart,
  FiCalendar,
  FiAward,
  FiMessageCircle,
  FiSliders,
  FiZap,
  FiTarget,
  FiBriefcase,
  FiSettings,
  FiShield,
  FiStar,
  FiLayers,
  FiRotateCcw,
  FiBell,
  FiList,
} from 'react-icons/fi';

// Every entry belongs to a `section` (see SECTION_ORDER below), so the sidebar reads as a set of labeled
// groups instead of one long flat list - it also groups everything to do with a workflow, and its
// scrollable nav area (see .sidebar-nav in index.css) is what actually makes every item reachable: the
// list is longer than most screens, and the sidebar previously clipped it instead of scrolling.
const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', roles: null, icon: FiGrid, section: 'Overview' },
  { to: '/command-center', label: 'Command Center', roles: ['TENANT_ADMIN', 'MANAGER'], icon: FiActivity, section: 'Overview' },

  { to: '/pos', label: 'POS / Sales', permission: 'SALE:CREATE', icon: FiShoppingCart, section: 'Sales' },
  { to: '/sales-history', label: 'Sales History', permission: 'SALE:VIEW', icon: FiClock, section: 'Sales' },
  { to: '/quotations', label: 'Quotations', permission: 'QUOTATION:VIEW', icon: FiClipboard, section: 'Sales' },
  { to: '/sales-orders', label: 'Sales Orders', permission: 'SALES_ORDER:VIEW', icon: FiShoppingCart, section: 'Sales' },
  { to: '/returns-notes', label: 'Returns & Notes', anyPermission: ['SALES_RETURN:CREATE', 'PURCHASE_RETURN:CREATE', 'CREDIT_NOTE:CREATE', 'DEBIT_NOTE:CREATE'], icon: FiRotateCcw, section: 'Sales' },

  { to: '/products', label: 'Products', permission: 'PRODUCT:VIEW', icon: FiBox, section: 'Catalog' },
  { to: '/categories', label: 'Categories', permission: 'CATEGORY:VIEW', icon: FiTag, section: 'Catalog' },
  { to: '/brands', label: 'Brands', permission: 'BRAND:VIEW', icon: FiStar, section: 'Catalog' },
  { to: '/units', label: 'Units of Measure', permission: 'UNIT:VIEW', icon: FiLayers, section: 'Catalog' },

  { to: '/purchases', label: 'Purchases', permission: 'PURCHASE:VIEW', icon: FiTruck, section: 'Purchasing & Inventory' },
  { to: '/procurement', label: 'Procurement', permission: 'PURCHASE_REQUEST:VIEW', icon: FiClipboard, section: 'Purchasing & Inventory' },
  { to: '/warehouses', label: 'Warehouses', permission: 'WAREHOUSE:VIEW', icon: FiHome, section: 'Purchasing & Inventory' },
  { to: '/stock-transfers', label: 'Stock Transfers', permission: 'STOCK_TRANSFER:VIEW', icon: FiShuffle, section: 'Purchasing & Inventory' },

  { to: '/accounting', label: 'Accounting', permission: 'JOURNAL:VIEW', icon: FiBookOpen, section: 'Accounting & Finance' },
  { to: '/accounting/chart-of-accounts', label: 'Chart of Accounts', permission: 'ACCOUNT:VIEW', icon: FiLayers, section: 'Accounting & Finance' },
  { to: '/accounting/journal-entries', label: 'Journal Entries', permission: 'JOURNAL:VIEW', icon: FiClipboard, section: 'Accounting & Finance' },
  { to: '/accounting/opening-balances', label: 'Opening Balances', permission: 'OPENING_BALANCE:VIEW', icon: FiSliders, section: 'Accounting & Finance' },
  { to: '/accounting/reports', label: 'Financial Reports', permission: 'REPORT:VIEW', icon: FiBarChart2, section: 'Accounting & Finance' },
  { to: '/receivables', label: 'Receivables', permission: 'REPORT:VIEW', icon: FiDollarSign, section: 'Accounting & Finance' },
  { to: '/payables', label: 'Payables', permission: 'REPORT:VIEW', icon: FiTruck, section: 'Accounting & Finance' },
  { to: '/expenses', label: 'Expenses', permission: 'EXPENSE:VIEW', icon: FiDollarSign, section: 'Accounting & Finance' },
  { to: '/credit-notes', label: 'Credit Notes', permission: 'CREDIT_NOTE:VIEW', icon: FiRotateCcw, section: 'Accounting & Finance' },
  { to: '/debit-notes', label: 'Debit Notes', permission: 'DEBIT_NOTE:VIEW', icon: FiRotateCcw, section: 'Accounting & Finance' },

  { to: '/customers', label: 'Customers', roles: null, icon: FiUsers, section: 'Contacts' },
  { to: '/suppliers', label: 'Suppliers', roles: null, icon: FiUserCheck, section: 'Contacts' },
  { to: '/companies', label: 'Companies', permission: 'COMPANY:CREATE', icon: FiBriefcase, section: 'Contacts' },
  { to: '/branches', label: 'Branches', roles: null, icon: FiMapPin, section: 'Contacts' },

  { to: '/optical-orders', label: 'Optical Orders', permission: 'OPTICAL_ORDER:VIEW', module: 'OPTICAL', icon: FiEye, section: 'Clinical' },
  { to: '/patients', label: 'Patients', permission: 'PATIENT:VIEW', module: 'OPTICAL', icon: FiHeart, section: 'Clinical' },
  { to: '/appointments', label: 'Appointments', permission: 'APPOINTMENT:VIEW', module: 'OPTICAL', icon: FiCalendar, section: 'Clinical' },
  { to: '/doctors', label: 'Doctors', roles: ['TENANT_ADMIN', 'MANAGER', 'DOCTOR', 'RECEPTIONIST'], module: 'OPTICAL', icon: FiAward, section: 'Clinical' },

  { to: '/communication', label: 'Communication', permission: 'COMMUNICATION:VIEW', icon: FiMessageCircle, section: 'Communication & AI' },
  { to: '/automation-rules', label: 'Automation Rules', permission: 'COMMUNICATION:VIEW', icon: FiSliders, section: 'Communication & AI' },
  { to: '/ai-assistant', label: 'AI Assistant', roles: ['TENANT_ADMIN', 'MANAGER'], icon: FiZap, section: 'Communication & AI' },
  { to: '/recommendations', label: 'Recommendations', roles: ['TENANT_ADMIN', 'MANAGER'], icon: FiTarget, section: 'Communication & AI' },

  { to: '/reports', label: 'Reports', permission: 'REPORT:VIEW', icon: FiBarChart2, section: 'Insights & Monitoring' },
  { to: '/notifications', label: 'Notifications', roles: null, icon: FiBell, section: 'Insights & Monitoring' },
  { to: '/activity-log', label: 'Activity Log', permission: 'AUDIT_LOG:VIEW', icon: FiList, section: 'Insights & Monitoring' },
  { to: '/sync-monitor', label: 'Terminals & Sync', roles: ['TENANT_ADMIN', 'MANAGER'], icon: FiActivity, section: 'Insights & Monitoring' },
  { to: '/offline-history', label: 'History & Statements', anyPermission: ['SALE:VIEW', 'PURCHASE:VIEW', 'CUSTOMER:VIEW', 'SUPPLIER:VIEW'], icon: FiClock, section: 'Insights & Monitoring' },

  { to: '/users', label: 'Users', permission: 'USER:VIEW', icon: FiUserPlus, section: 'Administration' },
  { to: '/modules', label: 'Modules', permission: 'MODULE:VIEW', icon: FiGrid, section: 'Administration' },
  { to: '/business-profile', label: 'Business Profile', permission: 'TENANT:VIEW', icon: FiSettings, section: 'Administration' },
  { to: '/roles-permissions', label: 'Roles & Permissions', roles: ['TENANT_ADMIN'], icon: FiShield, section: 'Administration' },
];

// Display order for the groups above. A section with no visible items for the current user (permissions,
// roles, or a disabled industry pack such as "Clinical" without the Optical module) is simply skipped, not
// shown empty.
const SECTION_ORDER = [
  'Overview',
  'Sales',
  'Catalog',
  'Purchasing & Inventory',
  'Accounting & Finance',
  'Contacts',
  'Clinical',
  'Communication & AI',
  'Insights & Monitoring',
  'Administration',
];

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] ?? '').concat(parts.length > 1 ? parts[parts.length - 1][0] : '').toUpperCase();
}

export default function Layout() {
  const { user, logout, hasPermission, hasModule } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [online, setOnline] = useState(navigator.onLine);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [user?.tenantId]);

  // Phase 3.1: keeps this terminal's local read copy (stock above all) fresh in the background while
  // online - on start, every minute, on focus/reconnect, and right after any stock-changing request.
  // Fire-and-forget: it can never delay or fail anything the user is doing.
  useEffect(() => startLocalDataKeeper(user?.tenantId), [user?.tenantId]);

  // Phase 3.2: the sync engine runs by itself - on start (which also resumes a queue interrupted by a
  // restart or crash), when the browser comes back online, whenever something is queued, on focus, on
  // a 30 s heartbeat, and exactly when a retry backoff expires. Never blocks the UI.
  useEffect(() => startSyncCoordinator(user?.tenantId), [user?.tenantId]);
  // Phase 3.3.4: tell the server how this terminal is doing (unsent work, refused transactions) so a manager can see it.
  useEffect(() => startTerminalReporting(user?.tenantId), [user?.tenantId]);
  // Phase 3.4: a push that something changed on another terminal (refreshes the local copy at once), and
  // the background/storage safeguards for the unsent queue.
  useEffect(() => startRealtime(user?.tenantId), [user?.tenantId]);
  useEffect(() => startReliability(user?.tenantId), [user?.tenantId]);

  const visibleNav = NAV_ITEMS.filter((item) => {
    if (item.module && !hasModule(item.module)) return false;
    return item.anyPermission ? item.anyPermission.some(hasPermission) : item.permission ? hasPermission(item.permission) : !item.roles || item.roles.includes(user?.role);
  });
  // Grouped in display order; a section with nothing visible for this user is left out entirely.
  const navSections = SECTION_ORDER.map((section) => ({
    section,
    items: visibleNav.filter((item) => item.section === section),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="app-shell d-flex vh-100 overflow-hidden">
      <aside className={`border-end p-3 sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark">Bz</div>
          <div>
            <div className="sidebar-brand-name">BizOS</div>
            <div className="sidebar-brand-sub">by OSNUVORA</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {navSections.map(({ section, items }) => (
            <div className="sidebar-section" key={section}>
              <div className="sidebar-section-label">{section}</div>
              <div className="nav flex-column gap-1">
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/dashboard' || item.to === '/accounting'}
                      className={({ isActive }) => `sidebar-nav-link ${isActive ? 'active' : ''}`}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <Icon size={16} />
                      <span>{item.label}</span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex-grow-1 d-flex flex-column overflow-hidden">
        <header className="app-header d-flex align-items-center gap-2 border-bottom px-3 py-2">
          <button className="btn btn-sm btn-outline-secondary d-md-none" onClick={() => setSidebarOpen((v) => !v)}>
            <FiMenu />
          </button>
          <div className="d-flex align-items-center gap-2 overflow-hidden" style={{ minWidth: 0 }}>
            <SyncStatusWidget tenantId={user?.tenantId} online={online} />
          </div>
          <div className="flex-grow-1 d-none d-md-block" style={{ maxWidth: 420 }}>
            <GlobalSearch />
          </div>
          <div className="d-flex align-items-center gap-3 ms-auto flex-shrink-0">
            <NotificationBell />
            <button className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1" onClick={toggleTheme}>
              {theme === 'light' ? <FiMoon size={14} /> : <FiSun size={14} />}
              <span className="d-none d-sm-inline">{theme === 'light' ? 'Dark' : 'Light'}</span>
            </button>
            <div className="user-chip">
              <div className="user-avatar">{initials(user?.name)}</div>
              <div className="d-none d-sm-block lh-sm">
                <div className="small fw-semibold">{user?.name}</div>
                <div className="text-body-secondary" style={{ fontSize: '0.68rem' }}>
                  {user?.role}
                </div>
              </div>
            </div>
            <button
              className="btn btn-sm btn-outline-danger d-flex align-items-center gap-1"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              <FiLogOut size={14} />
              <span className="d-none d-sm-inline">Logout</span>
            </button>
          </div>
        </header>
        <OfflineUnlockBanner tenantId={user?.tenantId} />
        <main className="flex-grow-1 overflow-auto p-3 p-md-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
