"""Pruebas de lo que el conector decide leyendo la pantalla: python3 test/conector_test.py (la carpeta test choca con un módulo de Python si se usa -m unittest)"""
import importlib.util
import os
import unittest

ruta = os.path.join(os.path.dirname(__file__), "..", "scripts", "conector.py")
spec = importlib.util.spec_from_file_location("conector", ruta)
conector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(conector)


class Pantalla(unittest.TestCase):
    def test_une_el_enlace_partido_en_varias_lineas(self):
        p = "Use the url below\nhttps://claude.com/cai/oauth/authorize?a=1&b=user%\n3Aprofile&state=AB\nCD\n Paste code here if prompted >"
        self.assertEqual(conector.extraer_url(p), "https://claude.com/cai/oauth/authorize?a=1&b=user%3Aprofile&state=ABCD")

    def test_rechaza_un_enlace_de_otro_sitio(self):
        self.assertIsNone(conector.extraer_url("https://malicioso.example/x\nPaste code here"))
        self.assertIsNone(conector.extraer_url("https://claude.com.malicioso.example/x\nPaste code here"))
        self.assertIsNone(conector.extraer_url("sin enlace\nPaste code here"))

    def test_sabe_si_esta_listo_u_ocupado(self):
        self.assertTrue(conector.esta_listo("> \n  auto mode on (shift+tab to cycle)"))
        self.assertTrue(conector.esta_listo("> \n  ? for shortcuts"))
        self.assertFalse(conector.esta_listo("trabajando (esc to interrupt)\n shift+tab to cycle"))
        self.assertFalse(conector.esta_listo("Choose the text style"))

    def test_solo_responde_a_las_pantallas_conocidas(self):
        self.assertEqual(conector.teclas_para("Yes, I trust this folder"), ["Down", "Enter"])
        self.assertEqual(conector.teclas_para("Select login method:"), ["Enter"])
        self.assertIsNone(conector.teclas_para("Do you want to allow this dangerous thing?"))
        self.assertIsNone(conector.teclas_para("WARNING: bypass permissions mode"))


class Texto(unittest.TestCase):
    def test_deja_una_sola_linea_sin_controles(self):
        self.assertEqual(conector.limpiar_texto(" a\nb\x1b[31m\tc "), "a b [31m c")

    def test_neutraliza_shell_y_comandos(self):
        for texto in ("!rm -rf x", "/logout", "#nota", "&fondo", "@archivo"):
            self.assertTrue(conector.limpiar_texto(texto).startswith("Orden: "), texto)
        self.assertEqual(conector.limpiar_texto("hola"), "hola")

    def test_formato_del_codigo(self):
        self.assertTrue(conector.RE_CODIGO.match("uZNNemhl-_nHz7#DXyjb2NK"))
        for malo in ("corto", "con espacio largo", "a;rm -rf x aaaaaa", "$(id)aaaaaaaa", "a\nbcdefghijk"):
            self.assertFalse(conector.RE_CODIGO.match(malo), malo)


if __name__ == "__main__":
    unittest.main()
