import { test, expect } from "@playwright/test";

test("catalog separates applications from infrastructure and preserves direction links", async ({
  page,
}) => {
  const host = {
    id: "host1",
    revision: 1,
    name: "Server without web",
    description: "Manual description",
    type: "Сервер",
    url: "",
    hostname: "server.example",
    ip: "10.1.1.1",
    directions: ["Виртуализация"],
    aliases: [],
    tags: [],
    endpoints: [],
    links: [],
    relations: [],
    external_ids: [],
    operations: [],
    check: { kind: "", target: "", interval_seconds: 0 },
    source: "manual",
    lifecycle: "active",
  };
  if (path === '/resources') {
    const direction = new URL(route.request().url()).searchParams.get('direction');
    if (direction) data[path] = data[path].filter((r:any) => r.directions.includes(direction));
  }
  await route.fulfill({json:data[path]??[]});
 });
 await page.goto('/#catalog');
 await expect(page.getByRole('button',{name:'Web application',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Server without web',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Приложения 1',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Web application',exact:true}).click();
 const openLink=page.getByRole('dialog').getByRole('link',{name:'Открыть Web application',exact:true});
 await expect(openLink).toHaveAttribute('href','https://app.example/');
 await expect(openLink).toHaveAttribute('target','_blank');
 await expect(openLink).toHaveAttribute('rel','noopener noreferrer');
 await expect(openLink.locator('svg')).toHaveCount(1);
 await page.screenshot({path:test.info().outputPath('catalog-open-dark-1920.png')});
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Инфраструктура 1',exact:true}).click();
 await expect(page.getByRole('button',{name:'Server without web',exact:true})).toBeVisible();
 const hostRow=page.locator('.resource-row').filter({has:page.getByRole('button',{name:'Server without web',exact:true})});
 await expect(hostRow).toContainText('10.1.1.1');
 await expect(hostRow).toContainText('Manual description');
 await page.screenshot({path:test.info().outputPath('catalog-ip-dark.png')});
 await expect(page.getByRole('button',{name:'Web application',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Server without web',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
 expect(page.context().pages()).toHaveLength(1);
 await page.keyboard.press('Escape');
 await page.reload();
 await expect(page.getByRole('button',{name:'Инфраструктура 1',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.goto('/#catalog?direction='+encodeURIComponent('Виртуализация'));
 await page.reload();
 await expect(page.getByRole('button',{name:'Server without web',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Инфраструктура 1',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.setViewportSize({width:3440,height:1440});
 await page.evaluate(() => document.documentElement.dataset.theme='light');
 await page.screenshot({path:test.info().outputPath('catalog-ip-light.png')});
 await expect(page.getByRole('button',{name:'Server without web',exact:true})).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Приложения 0',exact:true}).click();
 await expect(page.getByRole('button',{name:'Server without web',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Сбросить фильтры',exact:true}).click();
 await expect(page.getByRole('button',{name:'Web application',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Web application',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('link',{name:'Открыть Web application',exact:true}).locator('svg')).toHaveCount(1);
 await page.screenshot({path:test.info().outputPath('catalog-open-light-3440.png')});
});
