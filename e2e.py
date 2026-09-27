"""
Test de bout en bout, en mode local (sans Supabase), sur iPhone et sur ordinateur.

    python3 e2e.py

Nécessite : pip install playwright  (et un Chromium : python3 -m playwright install chromium)
Données 100 % fictives : demo.json (sauvegarde) et demo-releve.pdf (relevé au format LCL).
"""
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / 'demo.json'
STATEMENT = ROOT / 'demo-releve.pdf'
PORT = 8766
URL = f'http://localhost:{PORT}/'


def clean(s):
    return s.replace(' ', ' ').replace('\xa0', ' ')


def text(loc):
    return clean(loc.inner_text())


def new_page(pw, device, errors, tag, when):
    b = pw.chromium.launch()
    opts = dict(pw.devices[device]) if device else {'viewport': {'width': 1280, 'height': 900}}
    ctx = b.new_context(**opts, locale='fr-FR', timezone_id='Europe/Paris', accept_downloads=True)
    page = ctx.new_page()
    page.on('console', lambda m: m.type == 'error' and errors.append(f'[{tag}] {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'[{tag}] {e}'))
    page.on('dialog', lambda d: d.accept())
    page.clock.set_fixed_time(when)
    page.goto(URL)
    page.get_by_role('button', name='Essayer sans compte (sur cet appareil)').click()
    return b, ctx, page


def add(page, amount, category, spread=None, reimb=False, label=None):
    page.locator('#fab').click()
    page.locator('#f-amount').fill(amount)
    if label:
        page.locator('#f-label').fill(label)
    if spread:
        page.locator('#f-spread').select_option(str(spread))
    if reimb:
        page.locator('#f-reimb').check()
    page.locator('.cat-pick', has_text=category).click()
    expect(page.locator('.sheet')).to_have_count(0)


def scenario(pw, device, errors):
    tag = device or 'ordinateur'
    b, ctx, page = new_page(pw, device, errors, tag, datetime(2026, 5, 25, 12))

    # ── Démarrage : sauvegarde importée depuis l'assistant ──
    expect(page.get_by_role('heading', name='Bienvenue')).to_be_visible()
    page.set_input_files('#import-file', str(FIXTURE))
    expect(page.get_by_test_id('restant')).to_be_visible(timeout=5000)
    # 2 100 − 200 (objectif) − 917,69 (dépensé) − 20,01 (abonnements à venir)
    assert text(page.get_by_test_id('restant')) == '962,30 €', text(page.get_by_test_id('restant'))
    assert text(page.get_by_test_id('depenses')) == '917,69 €'
    assert 'par jour pendant 7 jours' in text(page.locator('.hero'))
    assert 'lundi 25 mai' in text(page.locator('.today')).lower()

    # « À classer » → Transport ; le commerçant est retenu
    expect(page.locator('.inbox .tx')).to_have_count(1)
    page.locator('.inbox .tx').click()
    page.locator('.cat-pick', has_text='Transport').click()
    page.get_by_role('button', name='OK').click()
    expect(page.locator('.inbox')).to_have_count(0)

    # Ajout pré-rempli (comme le bouton d'ajout rapide) : catégorie suggérée
    page.goto(URL + '?ajout=1&montant=4,20%20%E2%82%AC&marchand=Le%20Zinc')
    expect(page.locator('#f-amount')).to_have_value('4,2')
    expect(page.locator('.cat-pick.suggested')).to_contain_text('Bar / resto')
    page.locator('.cat-pick.suggested').click()
    expect(page.locator('#toast')).to_contain_text('Bar / resto')

    # Ajout rapide, dépense lissée, avance à rembourser
    add(page, '12', 'Courses')
    add(page, '90', 'Transport', spread=3, label='Billet de train')
    add(page, '60', 'Bar / resto', reimb=True, label='Avance resto')
    assert text(page.get_by_test_id('depenses')) == '963,89 €', text(page.get_by_test_id('depenses'))  # train : 30 € ce mois-ci
    assert text(page.get_by_test_id('restant')) == '916,10 €'
    expect(page.locator('.refunds .refund-row')).to_have_count(1)
    page.locator('.refunds').get_by_role('button', name='Remboursé').click()
    page.get_by_role('button', name='En épargne, pour mes projets').click()
    expect(page.locator('.refunds')).to_have_count(0)

    # ── Mois suivant : charges fixes automatiques ──
    page.clock.set_fixed_time(datetime(2026, 6, 6, 9))
    page.reload()
    expect(page.locator('.month-title')).to_contain_text('juin 2026')
    assert text(page.get_by_test_id('depenses')) == '830,00 €'      # loyer + épargne auto + 1/3 du train
    page.reload()
    assert text(page.get_by_test_id('depenses')) == '830,00 €'      # pas de doublon

    # ── Import du relevé (PDF au format LCL) ──
    page.set_input_files('#statement-file', str(STATEMENT))
    expect(page.get_by_role('heading', name='Relevé LCL')).to_be_visible(timeout=15000)
    page.locator('[data-form="imp-owner"] [name="name"]').fill('DUPONT ALEX')
    page.locator('[data-form="imp-owner"]').get_by_role('button', name='Appliquer').click()
    stats = text(page.locator('.stats'))
    assert 'À ajouter\n5' in stats and 'Ignorées\n2' in stats and 'Déjà présentes\n1' in stats, stats
    pret = page.locator('.imp-row', has=page.locator('.imp-label', has_text='ECHEANCE PRET')).locator('select')
    pret.select_option('rembourse')
    carrefour = page.locator('.imp-row', has=page.locator('.imp-label', has_text='CARREFOUR'))
    expect(carrefour.locator('select')).to_have_value(carrefour.locator('option', has_text='Courses').get_attribute('value'))
    expect(page.locator('.imp-row', has=page.locator('.imp-label', has_text='SALAIRE')).locator('select')).to_have_value('salaire')
    page.get_by_role('button', name='Importer 7 opérations').click()
    expect(page.locator('#toast')).to_contain_text('4 opérations ajoutées', timeout=10000)
    # salaire du 29 mai : le budget de juin démarre ce jour-là
    assert 'du 29 mai au 30 juin' in text(page.locator('.month-head'))
    assert '2 100,00 €' in text(page.locator('.stat').nth(1))
    expect(page.locator('.refunds .refund-row')).to_have_count(1)     # le prêt, remboursement attendu
    # ré-importer le même relevé : tout est déjà là
    page.set_input_files('#statement-file', str(STATEMENT))
    expect(page.get_by_role('heading', name='Relevé LCL')).to_be_visible(timeout=15000)
    assert 'Déjà présentes\n8' in text(page.locator('.stats'))
    page.get_by_role('button', name='Annuler').click()

    # Mai clôturé : revenus − dépenses + remboursement mis en épargne
    page.locator('[data-act="month-prev"]').click()
    assert text(page.locator('.hero-amount')) == '1 157,71 €', text(page.locator('.hero-amount'))
    assert 'Épargné' in text(page.locator('.hero-label'))
    page.locator('[data-act="month-today"]').click()
    expect(page.locator('.compare .crow').first).to_be_visible()

    # ── Projets, comptes, simulations, réglages ──
    page.locator('#tabs [data-view="projets"]').click()
    assert '1 157,71' in text(page.locator('.hero'))
    form = page.locator('[data-form="proj-add"]')
    form.locator('[name="name"]').fill('Ordinateur')
    form.locator('[name="price"]').fill('900')
    form.get_by_role('button', name='Ajouter').click()
    expect(page.locator('h2', has_text='Mes projets')).to_contain_text('2/3')

    page.locator('#tabs [data-view="comptes"]').click()
    assert 'LCL' in text(page.locator('.list'))                        # créé par l'import, solde du relevé
    page.get_by_role('button', name='+ Ajouter un compte').click()
    page.locator('.chip', has_text='LEP').click()
    page.locator('[data-form="account"] [name="balance"]').fill('500')
    page.locator('[data-form="account"]').get_by_role('button', name='Enregistrer').click()
    expect(page.locator('.hero-amount')).to_have_text('6 113,58\xa0€')   # 3 000 + 2 613,58 + 500

    page.locator('#tabs [data-view="simus"]').click()
    page.locator('[data-tab="pret"]').click()
    assert '186,67' in text(page.locator('#sim-out'))

    page.locator('#tabs [data-view="reglages"]').click()
    assert 'dupont alex' not in text(page.locator('.list').nth(1)).lower()          # pas de règle pour ses propres virements
    assert 'echeance pret personnel' in text(page.locator('#view'))                 # choix retenu pour le prochain relevé
    field = page.locator('.cat-edit', has=page.locator('input[value="Courses"]')).locator('[data-cat="budget"]')
    field.fill('300')
    field.blur()
    page.reload()
    page.locator('#tabs [data-view="reglages"]').click()
    expect(page.locator('.cat-edit', has=page.locator('input[value="Courses"]')).locator('[data-cat="budget"]')).to_have_value('300')

    if not device:
        with page.expect_download() as dl:
            page.get_by_role('button', name='Exporter mes données').click()
        data = json.loads(Path(dl.value.path()).read_text())
        assert data['app'] == 'mon-budget' and data['version'] == 2
        assert len(data['data']['transactions']) == 19, len(data['data']['transactions'])
        assert 'shortcut_token' not in data['data']['settings'] and 'snapshot' not in data['data']['settings']
        assert any(r['action'] == 'rembourse' for r in data['data']['merchant_rules'])

        # Synchronisation : une deuxième fenêtre se met à jour toute seule
        other = ctx.new_page()
        other.clock.set_fixed_time(datetime(2026, 6, 6, 9))
        other.on('pageerror', lambda e: errors.append(f'[{tag} fenêtre 2] {e}'))
        other.goto(URL)
        other.locator('#tabs [data-view="mois"]').click()
        assert text(other.get_by_test_id('depenses')) == '830,00 €'
        page.locator('#tabs [data-view="mois"]').click()
        add(page, '7', 'Courses')
        expect(other.get_by_test_id('depenses')).to_have_text('837,00\xa0€', timeout=5000)
        other.close()

    ctx.close()
    b.close()
    print(f'✓ {tag}')


def wizard(pw, errors):
    """Un ami qui démarre de zéro avec l'assistant (paie le 26)."""
    b, ctx, page = new_page(pw, 'iPhone 13', errors, 'assistant', datetime(2026, 9, 27, 10))
    page.get_by_role('button', name='Commencer').click()
    page.locator('[data-wiz="income"]').fill('1800')
    page.locator('[data-wiz="payDay"]').fill('26')
    page.locator('[data-wiz="name"]').fill('MARTIN LEA')
    page.get_by_role('button', name='Continuer').click()
    page.locator('[data-wiz="fixed.0.amount"]').fill('650')
    page.locator('[data-wiz="fixed.1.amount"]').fill('15')
    page.get_by_role('button', name='Continuer').click()
    page.locator('[data-wiz="budgets.Courses"]').fill('200')
    page.locator('[data-wiz="budgets.Bar / resto"]').fill('80')
    page.get_by_role('button', name='Continuer').click()
    page.locator('[data-wiz="total"]').fill('1000')
    page.locator('[data-wiz="end"]').select_option('2027-03')
    page.get_by_role('button', name='Continuer').click()
    recap = text(page.locator('.result'))
    assert '968,33' in recap, recap                                  # 1 800 − 665 − 1 000/6
    page.get_by_role('button', name='C’est parti !').click()
    expect(page.get_by_test_id('restant')).to_have_text('968,33\xa0€', timeout=5000)
    assert 'du 26 sept. au 25 oct.' in text(page.locator('.month-head')), text(page.locator('.month-head'))
    page.locator('.banner.action').click()                           # « Salaire reçu »
    page.locator('[data-form="salary"] [name="income"]').fill('1850')
    page.locator('[data-form="salary"]').get_by_role('button', name='Enregistrer').click()
    expect(page.get_by_test_id('restant')).to_have_text('1 018,33\xa0€')
    ctx.close()
    b.close()
    print('✓ assistant')


def main():
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '-d', str(ROOT)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    errors = []
    try:
        with sync_playwright() as pw:
            scenario(pw, 'iPhone 13', errors)
            scenario(pw, None, errors)
            wizard(pw, errors)
    finally:
        srv.terminate()
    if errors:
        print('Erreurs dans la console :', *errors, sep='\n  ')
        sys.exit(1)
    print('Tous les tests de bout en bout passent.')


if __name__ == '__main__':
    main()
