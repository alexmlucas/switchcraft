#include <gtk/gtk.h>

void end_program(GtkWidget *wid, gpointer ptr)
{
	gtk_main_quit();
}

void main(int argc, char *argv[])
{
	gtk_init(&argc, &argv);
	
	GtkBuilder *builder = gtk_builder_new_from_file("firstGlade.glade");
	
	GtkWidget *win = (GtkWidget *) gtk_builder_get_object(builder, "window1");
	GtkWidget *btn = (GtkWidget *) gtk_builder_get_object(builder, "button1");
	g_signal_connect(btn, "clicked", G_CALLBACK(end_program), NULL);

	gtk_widget_show_all(win);
	gtk_main();
}
