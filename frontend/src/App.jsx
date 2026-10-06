import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';

import Landing from './pages/landing/Landing';
import Login from './pages/auth/Login';
import RegisterTenant from './pages/auth/RegisterTenant';
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
import Dashboard from './pages/dashboard/Dashboard';
import CommandCenter from './pages/dashboard/CommandCenter';
import Products from './pages/products/Products';
import Categories from './pages/categories/Categories';
import Brands from './pages/brands/Brands';
import Units from './pages/units/Units';
import Customers from './pages/customers/Customers';
import Suppliers from './pages/suppliers/Suppliers';
import Branches from './pages/branches/Branches';
import Companies from './pages/companies/Companies';
import Purchases from './pages/purchases/Purchases';
import Pos from './pages/sales/Pos';
import SalesHistory from './pages/sales/SalesHistory';
import OpticalOrders from './pages/opticalOrders/OpticalOrders';
import Expenses from './pages/expenses/Expenses';
import ReturnsNotes from './pages/returnsNotes/ReturnsNotes';
import SyncMonitor from './pages/syncMonitor/SyncMonitor';
import OfflineHistory from './pages/offlineHistory/OfflineHistory';
import CreditNotes from './pages/creditNotes/CreditNotes';
import DebitNotes from './pages/debitNotes/DebitNotes';
import Quotations from './pages/quotations/Quotations';
import SalesOrders from './pages/salesOrders/SalesOrders';
import Notifications from './pages/notifications/Notifications';
import ActivityLog from './pages/activityLog/ActivityLog';
import Reports from './pages/reports/Reports';
import Users from './pages/users/Users';
import Accounting from './pages/accounting/Accounting';
import ChartOfAccounts from './pages/accounting/ChartOfAccounts';
import JournalEntries from './pages/accounting/JournalEntries';
import OpeningBalances from './pages/accounting/OpeningBalances';
import PartyBalances from './pages/receivables/PartyBalances';
import FinancialReports from './pages/accounting/FinancialReports';
import Procurement from './pages/procurement/Procurement';
import Warehouses from './pages/warehouses/Warehouses';
import StockTransfers from './pages/warehouses/StockTransfers';
import Patients from './pages/patients/Patients';
import Appointments from './pages/clinical/Appointments';
import Doctors from './pages/clinical/Doctors';
import CommunicationCenter from './pages/communication/CommunicationCenter';
import AutomationRules from './pages/communication/AutomationRules';
import AiAssistant from './pages/ai/AiAssistant';
import RecommendationCenter from './pages/ai/RecommendationCenter';
import Modules from './pages/settings/Modules';
import TenantProfile from './pages/settings/TenantProfile';
import RolesPermissions from './pages/settings/RolesPermissions';
import PortalLogin from './pages/portal/PortalLogin';
import PortalDashboard from './pages/portal/PortalDashboard';
import { PortalAuthProvider } from './portal/PortalAuthContext';

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<RegisterTenant />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />

            {/* Customer Portal: a fully separate authentication flow (OTP,
                its own token) and its own minimal shell - deliberately not
                nested under the staff Layout/ProtectedRoute above. */}
            <Route
              path="/portal/*"
              element={
                <PortalAuthProvider>
                  <Routes>
                    <Route path="login" element={<PortalLogin />} />
                    <Route path="*" element={<PortalDashboard />} />
                  </Routes>
                </PortalAuthProvider>
              }
            />

            <Route
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route path="/dashboard" element={<Dashboard />} />
              <Route
                path="/command-center"
                element={
                  <ProtectedRoute roles={['TENANT_ADMIN', 'MANAGER']}>
                    <CommandCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/pos"
                element={
                  <ProtectedRoute permission="SALE:CREATE">
                    <Pos />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/sales-history"
                element={
                  <ProtectedRoute permission="SALE:VIEW">
                    <SalesHistory />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/quotations"
                element={
                  <ProtectedRoute permission="QUOTATION:VIEW">
                    <Quotations />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/sales-orders"
                element={
                  <ProtectedRoute permission="SALES_ORDER:VIEW">
                    <SalesOrders />
                  </ProtectedRoute>
                }
              />
              <Route path="/returns-notes" element={<ReturnsNotes />} />
              <Route path="/offline-history" element={<OfflineHistory />} />
              <Route
                path="/sync-monitor"
                element={
                  <ProtectedRoute roles={['TENANT_ADMIN', 'MANAGER']}>
                    <SyncMonitor />
                  </ProtectedRoute>
                }
              />
              <Route path="/products" element={<Products />} />
              <Route
                path="/categories"
                element={
                  <ProtectedRoute permission="CATEGORY:VIEW">
                    <Categories />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/brands"
                element={
                  <ProtectedRoute permission="BRAND:VIEW">
                    <Brands />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/units"
                element={
                  <ProtectedRoute permission="UNIT:VIEW">
                    <Units />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/purchases"
                element={
                  <ProtectedRoute permission="PURCHASE:VIEW">
                    <Purchases />
                  </ProtectedRoute>
                }
              />
              <Route path="/customers" element={<Customers />} />
              <Route path="/suppliers" element={<Suppliers />} />
              <Route path="/branches" element={<Branches />} />
              <Route path="/companies" element={<Companies />} />
              <Route
                path="/optical-orders"
                element={
                  <ProtectedRoute permission="OPTICAL_ORDER:VIEW" module="OPTICAL">
                    <OpticalOrders />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/expenses"
                element={
                  <ProtectedRoute permission="EXPENSE:VIEW">
                    <Expenses />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/credit-notes"
                element={
                  <ProtectedRoute permission="CREDIT_NOTE:VIEW">
                    <CreditNotes />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/debit-notes"
                element={
                  <ProtectedRoute permission="DEBIT_NOTE:VIEW">
                    <DebitNotes />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/reports"
                element={
                  <ProtectedRoute permission="REPORT:VIEW">
                    <Reports />
                  </ProtectedRoute>
                }
              />
              <Route path="/notifications" element={<Notifications />} />
              <Route
                path="/activity-log"
                element={
                  <ProtectedRoute permission="AUDIT_LOG:VIEW">
                    <ActivityLog />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/users"
                element={
                  <ProtectedRoute permission="USER:VIEW">
                    <Users />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/modules"
                element={
                  <ProtectedRoute permission="MODULE:VIEW">
                    <Modules />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/business-profile"
                element={
                  <ProtectedRoute permission="TENANT:VIEW">
                    <TenantProfile />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/roles-permissions"
                element={
                  <ProtectedRoute roles={['TENANT_ADMIN']}>
                    <RolesPermissions />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/accounting/reports"
                element={
                  <ProtectedRoute permission="REPORT:VIEW">
                    <FinancialReports />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/receivables"
                element={
                  <ProtectedRoute permission="REPORT:VIEW">
                    <PartyBalances side="AR" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/payables"
                element={
                  <ProtectedRoute permission="REPORT:VIEW">
                    <PartyBalances side="AP" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/accounting/chart-of-accounts"
                element={
                  <ProtectedRoute permission="ACCOUNT:VIEW">
                    <ChartOfAccounts />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/accounting/journal-entries"
                element={
                  <ProtectedRoute permission="JOURNAL:VIEW">
                    <JournalEntries />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/accounting/opening-balances"
                element={
                  <ProtectedRoute permission="OPENING_BALANCE:VIEW">
                    <OpeningBalances />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/accounting"
                element={
                  <ProtectedRoute permission="JOURNAL:VIEW">
                    <Accounting />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/procurement"
                element={
                  <ProtectedRoute permission="PURCHASE_REQUEST:VIEW">
                    <Procurement />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/warehouses"
                element={
                  <ProtectedRoute permission="WAREHOUSE:VIEW">
                    <Warehouses />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/stock-transfers"
                element={
                  <ProtectedRoute permission="STOCK_TRANSFER:VIEW">
                    <StockTransfers />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/patients"
                element={
                  <ProtectedRoute permission="PATIENT:VIEW" module="OPTICAL">
                    <Patients />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/appointments"
                element={
                  <ProtectedRoute permission="APPOINTMENT:VIEW" module="OPTICAL">
                    <Appointments />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/doctors"
                element={
                  <ProtectedRoute roles={['TENANT_ADMIN', 'MANAGER', 'DOCTOR', 'RECEPTIONIST']} module="OPTICAL">
                    <Doctors />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/communication"
                element={
                  <ProtectedRoute permission="COMMUNICATION:VIEW">
                    <CommunicationCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/automation-rules"
                element={
                  <ProtectedRoute permission="COMMUNICATION:VIEW">
                    <AutomationRules />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/ai-assistant"
                element={
                  <ProtectedRoute roles={['TENANT_ADMIN', 'MANAGER']}>
                    <AiAssistant />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/recommendations"
                element={
                  <ProtectedRoute roles={['TENANT_ADMIN', 'MANAGER']}>
                    <RecommendationCenter />
                  </ProtectedRoute>
                }
              />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
