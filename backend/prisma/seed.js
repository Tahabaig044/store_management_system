// Demo/seed data - NOT run as part of production migrations.
// Run manually with `npm run seed` after `prisma migrate deploy`.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function hash(pw) {
  return bcrypt.hash(pw, 12);
}

async function main() {
  const superAdminEmail = (process.env.SEED_SUPER_ADMIN_EMAIL || 'superadmin@akvisionflow.com').toLowerCase();
  const superAdminPassword = process.env.SEED_SUPER_ADMIN_PASSWORD || 'change-me-now';

  const existingSuperAdmin = await prisma.user.findFirst({ where: { email: superAdminEmail, tenantId: null } });
  if (!existingSuperAdmin) {
    await prisma.user.create({
      data: {
        tenantId: null,
        name: 'Platform Super Admin',
        email: superAdminEmail,
        passwordHash: await hash(superAdminPassword),
        role: 'SUPER_ADMIN',
      },
    });
    console.log(`Created SUPER_ADMIN user: ${superAdminEmail}`);
  } else {
    console.log('SUPER_ADMIN user already exists, skipping.');
  }

  const demoTenantName = process.env.SEED_DEMO_TENANT_NAME || 'Khalid Eye Clinic';
  const demoAdminEmail = (process.env.SEED_DEMO_ADMIN_EMAIL || 'admin@khalideyeclinic.test').toLowerCase();
  const demoAdminPassword = process.env.SEED_DEMO_ADMIN_PASSWORD || 'change-me-now';

  let tenant = await prisma.tenant.findFirst({ where: { businessName: demoTenantName } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: demoTenantName,
        businessName: demoTenantName,
        subscription: { create: { plan: 'trial', status: 'TRIAL' } },
      },
    });

    const branch = await prisma.branch.create({
      data: { tenantId: tenant.id, name: 'Main Branch', isMain: true },
    });

    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        name: 'Demo Tenant Admin',
        email: demoAdminEmail,
        passwordHash: await hash(demoAdminPassword),
        role: 'TENANT_ADMIN',
      },
    });

    const frameCategory = await prisma.category.create({ data: { tenantId: tenant.id, name: 'Frames' } });
    const lensCategory = await prisma.category.create({ data: { tenantId: tenant.id, name: 'Lenses' } });
    const medCategory = await prisma.category.create({ data: { tenantId: tenant.id, name: 'Medicines' } });

    await prisma.product.createMany({
      data: [
        {
          tenantId: tenant.id,
          categoryId: frameCategory.id,
          type: 'FRAME',
          name: 'Classic Black Frame',
          sku: 'FRM-001',
          purchasePrice: 15,
          sellingPrice: 35,
          stockQuantity: 20,
          lowStockThreshold: 5,
          frameBrand: 'Generic',
          frameColor: 'Black',
        },
        {
          tenantId: tenant.id,
          categoryId: lensCategory.id,
          type: 'LENS',
          name: 'Single Vision Lens (CR-39)',
          sku: 'LNS-001',
          purchasePrice: 8,
          sellingPrice: 20,
          stockQuantity: 50,
          lowStockThreshold: 10,
          lensType: 'Single Vision',
          lensMaterial: 'CR-39',
        },
        {
          tenantId: tenant.id,
          categoryId: medCategory.id,
          type: 'MEDICINE',
          name: 'Eye Drops - Lubricant',
          sku: 'MED-001',
          purchasePrice: 2,
          sellingPrice: 5,
          stockQuantity: 30,
          lowStockThreshold: 10,
          batchNumber: 'B2026-01',
          expiryDate: new Date(new Date().getFullYear() + 1, 0, 1),
        },
      ],
    });

    await prisma.expenseCategory.createMany({
      data: [
        { tenantId: tenant.id, name: 'Rent' },
        { tenantId: tenant.id, name: 'Utilities' },
        { tenantId: tenant.id, name: 'Salaries' },
      ],
    });

    await prisma.customer.create({
      data: { tenantId: tenant.id, name: 'Walk-in Customer', phone: '' },
    });

    await prisma.supplier.create({
      data: { tenantId: tenant.id, name: 'Generic Optical Supplies Co.' },
    });

    console.log(`Created demo tenant "${demoTenantName}" with admin: ${demoAdminEmail}`);
  } else {
    console.log(`Demo tenant "${demoTenantName}" already exists, skipping.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
