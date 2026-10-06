import { Link } from 'react-router-dom';

const FEATURES = [
  { title: 'Sales & POS', text: 'Fast point-of-sale checkout, quotations, sales orders and returns.' },
  { title: 'Inventory Management', text: 'Track stock across branches and warehouses, with transfers and adjustments.' },
  { title: 'Accounting & Financial Reports', text: 'Chart of accounts, journal entries and ready-to-use financial statements.' },
  { title: 'Customers & Suppliers', text: 'One place for your parties, balances and history.' },
  { title: 'Purchase Management', text: 'Purchase orders, receiving and procurement workflows.' },
  { title: 'Business Dashboard & Analytics', text: 'Live KPIs and reports to see how the business is performing.' },
];

// Public entry page at the app root. The authenticated dashboard lives at /dashboard.
export default function Landing() {
  return (
    <div className="bg-body-tertiary min-vh-100">
      <header className="container py-3 d-flex align-items-center justify-content-between">
        <div className="d-flex align-items-center gap-2">
          <div className="sidebar-brand-mark">Bz</div>
          <div>
            <div className="fw-semibold">BizOS</div>
            <div className="small text-body-secondary">by OSNUVORA</div>
          </div>
        </div>
        <Link to="/login" className="btn btn-outline-primary btn-sm">Login</Link>
      </header>

      <main className="container py-5">
        <section className="text-center mb-5">
          <h1 className="display-5 fw-bold">BizOS — Business Operating System</h1>
          <p className="lead text-body-secondary mx-auto" style={{ maxWidth: '640px' }}>
            Run sales, stock, accounting and purchasing from a single platform, built for growing businesses.
          </p>
          <div className="d-flex justify-content-center gap-2 mt-4">
            <Link to="/login" className="btn btn-primary btn-lg">Login</Link>
            <Link to="/register" className="btn btn-outline-primary btn-lg">Create Your Account</Link>
          </div>
        </section>

        <section className="row g-3 mb-5" aria-label="Key features">
          {FEATURES.map((f) => (
            <div className="col-12 col-md-6 col-lg-4" key={f.title}>
              <div className="card h-100 shadow-sm">
                <div className="card-body">
                  <h5 className="card-title">{f.title}</h5>
                  <p className="card-text text-body-secondary mb-0">{f.text}</p>
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="text-center card shadow-sm p-4">
          <h2 className="h4">Ready to get started?</h2>
          <p className="text-body-secondary">Sign in to your workspace or create a new business account in minutes.</p>
          <div className="d-flex justify-content-center gap-2">
            <Link to="/login" className="btn btn-primary">Login</Link>
            <Link to="/register" className="btn btn-outline-primary">Create Your Account</Link>
          </div>
        </section>
      </main>
    </div>
  );
}
