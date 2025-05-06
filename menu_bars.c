#include <gtk/gtk.h>

void end_program(GtkWidget *wid, gpointer ptr)
{
	gtk_main_quit();
}

void button_popup(GtkWidget *wid, gpointer ptr)
{
	GtkWidget *f_menu = gtk_menu_new();
	GtkWidget *quit_mi = gtk_menu_item_new_with_label("Quit");
	gtk_menu_shell_append(GTK_MENU_SHELL(f_menu), quit_mi);
	g_signal_connect(quit_mi, "activate", G_CALLBACK(end_program), NULL);
	
	gtk_widget_show_all(f_menu);
	gtk_menu_popup_at_pointer(GTK_MENU(f_menu), gtk_get_current_event());
}

void open_dialog(GtkWidget *wid, gpointer ptr)
{
	GtkWidget *dlg = gtk_dialog_new_with_buttons("My Dialog", GTK_WINDOW(ptr),
		GTK_DIALOG_MODAL | GTK_DIALOG_DESTROY_WITH_PARENT, "Cancel", 0, "OK", 1, NULL);
	
	GtkWidget *lbl = gtk_label_new("A question for the user");
	
	gtk_container_add(GTK_CONTAINER(gtk_dialog_get_content_area(GTK_DIALOG(dlg))), lbl);
	gtk_widget_show(lbl);
	
	int result = gtk_dialog_run(GTK_DIALOG(dlg));
	gtk_widget_destroy(dlg);
	printf("Return code = %d\n", result);
}

static void file_selected(GtkFileChooserButton *btn, gpointer ptr)
{
	printf("%s selected\n", gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(btn)));	
}

static void save_file(GtkWidget *btn, gpointer ptr)
{
	GtkWidget *sch = gtk_file_chooser_dialog_new("Save file", GTK_WINDOW(ptr), GTK_FILE_CHOOSER_ACTION_SAVE, "Cancel", 0, "OK", 1, NULL);
	if(gtk_dialog_run(GTK_DIALOG(sch)) == 1)
	{
		printf("%s selected\n", gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(sch)));
	}
	gtk_widget_destroy(sch);
}

static void col_selected(GtkColorChooser *btn, gpointer ptr)
{
	GdkRGBA col;
	gtk_color_chooser_get_rgba(btn, &col);
	printf("red = %f; green = %f; blue = %f\n", col.red, col.green, col.blue);
}

void main(int argc, char *argv[])
{
	gtk_init(&argc, &argv);
	
	GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
	GtkWidget *btn = gtk_button_new_with_label("Close window");
	GtkWidget *btn_pop = gtk_button_new_with_label("Pop");
	GtkWidget *btn_dia = gtk_button_new_with_label("Dia");
	g_signal_connect(btn, "clicked", G_CALLBACK(end_program), NULL);
	g_signal_connect(btn_pop, "clicked", G_CALLBACK(button_popup), NULL);
	g_signal_connect(btn_dia, "clicked", G_CALLBACK(open_dialog), win);
	g_signal_connect(win, "delete_event", G_CALLBACK(end_program), NULL);
	
	GtkWidget *mbar = gtk_menu_bar_new();
	GtkWidget *vbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 5);
	gtk_box_pack_start(GTK_BOX(vbox), mbar, TRUE, TRUE, 0);
	gtk_container_add(GTK_CONTAINER(win), vbox);
	
	GtkWidget *fc_btn = gtk_button_new_with_label("Save file");
	g_signal_connect(fc_btn, "clicked", G_CALLBACK(save_file), win);
	
	GtkWidget *file_mi = gtk_menu_item_new_with_label("File");
	gtk_menu_shell_append(GTK_MENU_SHELL(mbar), file_mi);
	
	GtkWidget *f_menu = gtk_menu_new();
	gtk_menu_item_set_submenu(GTK_MENU_ITEM(file_mi), f_menu);
	
	GtkWidget *quit_mi = gtk_menu_item_new_with_label("Quit");
	gtk_menu_shell_append(GTK_MENU_SHELL (f_menu), quit_mi);
	g_signal_connect(quit_mi, "activate", G_CALLBACK(end_program), NULL);
	
	GtkWidget *col_btn = gtk_font_button_new();
	g_signal_connect(col_btn, "color-set", G_CALLBACK(col_selected), NULL);
	
	gtk_box_pack_start(GTK_BOX(vbox), col_btn, TRUE, TRUE, 0);
	gtk_box_pack_start(GTK_BOX(vbox), fc_btn, TRUE, TRUE, 0);
	gtk_box_pack_start(GTK_BOX(vbox), btn, TRUE, TRUE, 0);
	gtk_box_pack_start(GTK_BOX(vbox), btn_pop, TRUE, TRUE, 0);
	gtk_box_pack_start(GTK_BOX(vbox), btn_dia, TRUE, TRUE, 0);

	gtk_widget_show_all(win);
	gtk_main();
} 
